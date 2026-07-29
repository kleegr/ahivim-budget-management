import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { tryDec, toMoney, formatMoney, type MoneyInput } from "@/lib/money";
import { normalizePersonName } from "@/lib/business/name-matching";

/**
 * EMPLOYEE-PAYMENT ATTRIBUTION
 * ============================
 *
 * A payroll transaction records an agency GROSS amount and an INTERNAL amount.
 * Who the money actually went to — the employee directly, the staffing agency
 * ("Excellent Staffing"), or someone we cannot classify — is a separate fact,
 * and one the imported figures never state outright. This module derives it
 * from the pay-to text and the two amounts, and back-fills it onto the three
 * newer nullable columns.
 *
 * SAFETY: this never touches the imported figures (imported_amount /
 * imported_hours / imported_rate). It only ever writes payment_recipient,
 * employee_payment_amount and agency_additional_amount, and it runs as a
 * deliberate back-fill — never during an import commit.
 */

export type PaymentRecipient = "employee" | "excellent_staffing" | "unknown";

export interface AttributePaymentInput {
  payToRaw: string | null | undefined;
  employeeName: string | null | undefined;
  importedAmount: MoneyInput;
  internalAmount: MoneyInput;
}

export interface AttributePaymentResult {
  recipient: PaymentRecipient;
  /** The internal amount, when the recipient is the employee. Otherwise null. */
  employeePayment: string | null;
  /** imported − internal, floored at zero. Null when either amount is unknown. */
  agencyAdditional: string | null;
  /** A plain-language explanation of every decision above. */
  reason: string;
}

/**
 * Classify a single transaction. PURE: no I/O, so it is trivially testable and
 * carries its own explanation in `reason`.
 *
 * Heuristic, in order:
 *   1. pay-to contains "excellent" or "staffing" (case-insensitive) -> agency
 *   2. pay-to's normalized form equals the employee's normalized name -> employee
 *   3. otherwise -> unknown
 *
 * agencyAdditional = imported − internal when both are known; a negative
 * difference is recorded as 0 and the reason says so. employeePayment is the
 * internal amount only when the recipient is the employee.
 */
export function attributePayment(input: AttributePaymentInput): AttributePaymentResult {
  const payTo = (input.payToRaw ?? "").trim();
  const payToLower = payTo.toLowerCase();
  const imported = tryDec(input.importedAmount);
  const internal = tryDec(input.internalAmount);

  // Agency additional: what the agency keeps above the internal amount. Only
  // meaningful when both figures are present; never allowed to go negative.
  let agencyAdditional: string | null = null;
  let agencyNote = "";
  if (imported && internal) {
    const diff = imported.minus(internal);
    if (diff.isNegative()) {
      agencyAdditional = toMoney(0);
      agencyNote =
        ` Agency additional would be negative (imported ${formatMoney(imported)} − internal ` +
        `${formatMoney(internal)} = ${formatMoney(diff)}); recorded as ${formatMoney(0)}.`;
    } else {
      agencyAdditional = toMoney(diff);
    }
  } else {
    agencyNote = " Agency additional not computed: an amount was missing.";
  }

  let recipient: PaymentRecipient;
  let reason: string;
  const normalizedPayTo = normalizePersonName(payTo);
  const normalizedEmployee = normalizePersonName(input.employeeName);

  if (!payTo) {
    recipient = "unknown";
    reason = "No pay-to name is recorded, so the recipient cannot be determined.";
  } else if (payToLower.includes("excellent") || payToLower.includes("staffing")) {
    recipient = "excellent_staffing";
    reason = `Pay-to “${payTo}” contains an agency marker (“excellent”/“staffing”).`;
  } else if (normalizedPayTo !== "" && normalizedPayTo === normalizedEmployee) {
    recipient = "employee";
    reason = `Pay-to “${payTo}” matches the employee name “${input.employeeName}”.`;
  } else {
    recipient = "unknown";
    reason = input.employeeName
      ? `Pay-to “${payTo}” is neither an agency marker nor a match for employee “${input.employeeName}”.`
      : `Pay-to “${payTo}” has no agency marker and there is no employee name to match against.`;
  }

  const employeePayment = recipient === "employee" && internal ? toMoney(internal) : null;

  return { recipient, employeePayment, agencyAdditional, reason: reason + agencyNote };
}

interface BackfillRow {
  id: string;
  pay_to_raw: string | null;
  employee_name: string | null;
  imported_amount: string | null;
  internal_amount: string | null;
}

/**
 * Back-fill attribution across every payroll transaction, or one batch.
 *
 * The internal amount is resolved the same way the rest of the app resolves it:
 * the application's own calculated figure first, then the spreadsheet's column
 * P, then the rate applied times the imported hours. Only the three attribution
 * columns are ever written. Returns the number of rows updated.
 */
export async function backfillPaymentAttribution(
  pool: PgLikePool,
  opts: { batchId?: string | null } = {},
  actorId: string | null = null,
): Promise<number> {
  const batchId = opts.batchId ?? null;

  const { rows } = await pool.query<BackfillRow>(
    `SELECT t.id,
            t.pay_to_raw,
            COALESCE(e.display_name, t.employee_raw) AS employee_name,
            t.imported_amount::text AS imported_amount,
            COALESCE(
              t.calculated_internal_amount,
              t.spreadsheet_internal_amount,
              t.internal_rate_applied * t.imported_hours
            )::text AS internal_amount
       FROM payroll_transactions t
       LEFT JOIN employees e ON e.id = t.employee_id
      WHERE ($1::uuid IS NULL OR t.import_batch_id = $1::uuid)`,
    [batchId],
  );

  let updated = 0;
  for (const row of rows) {
    const attribution = attributePayment({
      payToRaw: row.pay_to_raw,
      employeeName: row.employee_name,
      importedAmount: row.imported_amount,
      internalAmount: row.internal_amount,
    });
    await pool.query(
      `UPDATE payroll_transactions
          SET payment_recipient        = $1,
              employee_payment_amount  = $2,
              agency_additional_amount = $3,
              updated_at               = now()
        WHERE id = $4`,
      [attribution.recipient, attribution.employeePayment, attribution.agencyAdditional, row.id],
    );
    updated += 1;
  }

  await recordChange(pool, {
    actorId,
    action: "payment_attributed",
    entityType: batchId ? "import_batch" : "payroll_transactions",
    entityId: batchId,
    extra: { updated, batchId },
  });

  return updated;
}

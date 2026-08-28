import type { DirectPayTargetInterval } from "@/lib/business/direct-pay-targets";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { recordChange } from "@/lib/manage/audit";
import { fail, ok, type Result } from "@/lib/manage/errors";
import { dec, toMoney } from "@/lib/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function optionalDate(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function storedDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" ? value.slice(0, 10) : null;
}

function optionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

async function inTransaction<T>(pool: PgLikePool, run: (client: PgLikeClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface SaveDirectPayTargetInput {
  id?: string | null;
  employeeId: string;
  intervalUnit: DirectPayTargetInterval;
  intervalCount: number | string;
  grossTargetAmount: string;
  planningHourlyRate: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

export async function saveDirectPayTarget(
  pool: PgLikePool,
  input: SaveDirectPayTargetInput,
  actorId: string | null,
): Promise<Result<{ id: string }>> {
  if (!UUID.test(input.employeeId) || (input.id && !UUID.test(input.id))) {
    return fail("validation", "Choose a valid employee and target.");
  }
  if (!validDate(input.effectiveFrom)) return fail("validation", "Enter a valid effective date.");
  const effectiveTo = optionalDate(input.effectiveTo);
  if (effectiveTo && !validDate(effectiveTo)) return fail("validation", "Enter a valid end date.");
  if (effectiveTo && effectiveTo < input.effectiveFrom) return fail("validation", "The end date cannot be before the start date.");
  if (!(["week", "month", "custom"] as const).includes(input.intervalUnit)) {
    return fail("validation", "Choose a valid target interval.");
  }
  const intervalCount = Number(input.intervalCount);
  if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 52) {
    return fail("validation", "The interval count must be a whole number from 1 to 52.");
  }
  if (input.intervalUnit === "custom" && (!effectiveTo || intervalCount !== 1)) {
    return fail("validation", "A custom target needs an end date and uses one complete interval.");
  }
  let amount: string;
  let rate: string;
  try {
    amount = toMoney(input.grossTargetAmount);
    rate = toMoney(input.planningHourlyRate);
    if (!dec(amount).greaterThan(0) || !dec(rate).greaterThan(0)) throw new Error("positive values required");
  } catch {
    return fail("validation", "Gross target and planning hourly rate must both be greater than zero.");
  }

  try {
    return await inTransaction(pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('direct-pay-target:' || $1::text))`, [input.employeeId]);
      const employee = await client.query<{ id: string }>(
        `SELECT id FROM employees WHERE id = $1 AND status <> 'archived'`,
        [input.employeeId],
      );
      if (!employee.rows[0]) return fail("not_found", "That employee is not active.");
      const overlap = await client.query<{ id: string }>(
        `SELECT id FROM employee_direct_pay_targets
          WHERE employee_id = $1 AND status = 'active'
            AND ($2::uuid IS NULL OR id <> $2::uuid)
            AND daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')
                && daterange($3::date, COALESCE($4::date, 'infinity'::date), '[]')
          LIMIT 1`,
        [input.employeeId, input.id ?? null, input.effectiveFrom, effectiveTo],
      );
      if (overlap.rows[0]) return fail("conflict", "This employee already has an active target in that date range.");

      const previous = input.id
        ? await client.query<Record<string, unknown>>(`SELECT * FROM employee_direct_pay_targets WHERE id = $1 FOR UPDATE`, [input.id])
        : null;
      if (input.id && !previous?.rows[0]) return fail("not_found", "That direct-pay target no longer exists.");
      if (previous?.rows[0] && previous.rows[0].employee_id !== input.employeeId) {
        return fail("validation", "A target cannot be moved to another employee.");
      }

      const saved = input.id
        ? await client.query<{ id: string }>(
            `UPDATE employee_direct_pay_targets
                SET interval_unit = $2, interval_count = $3, gross_target_amount = $4,
                    planning_hourly_rate = $5, effective_from = $6::date,
                    effective_to = $7::date, notes = $8, updated_by_user_id = $9,
                    updated_at = now()
              WHERE id = $1 RETURNING id`,
            [input.id, input.intervalUnit, intervalCount, amount, rate, input.effectiveFrom, effectiveTo, optionalText(input.notes), actorId],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO employee_direct_pay_targets
               (employee_id, target_basis, interval_unit, interval_count,
                gross_target_amount, planning_hourly_rate, effective_from, effective_to,
                notes, created_by_user_id, updated_by_user_id)
             VALUES ($1, 'gross', $2, $3, $4, $5, $6::date, $7::date, $8, $9, $9)
             RETURNING id`,
            [input.employeeId, input.intervalUnit, intervalCount, amount, rate, input.effectiveFrom, effectiveTo, optionalText(input.notes), actorId],
          );
      const id = saved.rows[0].id;
      await recordChange(client, {
        actorId,
        action: input.id ? "direct_pay_target.updated" : "direct_pay_target.created",
        entityType: "employee_direct_pay_target",
        entityId: id,
        previous: previous?.rows[0] ?? undefined,
        next: { employeeId: input.employeeId, targetBasis: "gross", intervalUnit: input.intervalUnit, intervalCount, amount, rate, effectiveFrom: input.effectiveFrom, effectiveTo },
      });
      return ok({ id });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23P01") {
      return fail("conflict", "This employee already has an active target in that date range.");
    }
    throw error;
  }
}

export async function archiveDirectPayTarget(
  pool: PgLikePool,
  id: string,
  actorId: string | null,
): Promise<Result<{ id: string }>> {
  if (!UUID.test(id)) return fail("validation", "Choose a valid target.");
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE employee_direct_pay_targets
        SET status = 'archived', archived_at = now(), archived_by_user_id = $2,
            updated_by_user_id = $2, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING id`,
    [id, actorId],
  );
  if (!rows[0]) return fail("not_found", "That active target no longer exists.");
  await recordChange(pool, { actorId, action: "direct_pay_target.archived", entityType: "employee_direct_pay_target", entityId: id });
  return ok({ id });
}

export interface SavePayrollCheckInput {
  id?: string | null;
  employeeId: string;
  checkNumber?: string | null;
  checkDate?: string | null;
  periodBegin?: string | null;
  periodEnd?: string | null;
  actualGross?: string | null;
  actualNet: string;
  taxWithheld?: string | null;
  sourceRef?: string | null;
  verificationStatus?: "unverified" | "verified" | "void";
  notes?: string | null;
}

export async function savePayrollCheck(
  pool: PgLikePool,
  input: SavePayrollCheckInput,
  actorId: string | null,
): Promise<Result<{ id: string; linkedTransactions: number }>> {
  if (!UUID.test(input.employeeId) || (input.id && !UUID.test(input.id))) {
    return fail("validation", "Choose a valid employee and payroll check.");
  }
  const checkNumber = optionalText(input.checkNumber);
  const checkDate = optionalDate(input.checkDate);
  const periodBegin = optionalDate(input.periodBegin);
  const periodEnd = optionalDate(input.periodEnd);
  for (const [value, label] of [[checkDate, "check"], [periodBegin, "period start"], [periodEnd, "period end"]] as const) {
    if (value && !validDate(value)) return fail("validation", `Enter a valid ${label} date.`);
  }
  if (!checkDate && !periodBegin && !periodEnd) {
    return fail("validation", "Add a check date or pay-period date so the record can be matched safely.");
  }
  if (periodBegin && periodEnd && periodEnd < periodBegin) return fail("validation", "The pay period end cannot be before its start.");
  let gross: string | null;
  let net: string;
  let tax: string | null;
  try {
    gross = input.actualGross == null || input.actualGross.trim() === "" ? null : toMoney(input.actualGross);
    net = toMoney(input.actualNet);
    tax = input.taxWithheld == null || input.taxWithheld.trim() === "" ? null : toMoney(input.taxWithheld);
    if (dec(net).isNegative() || (gross && dec(gross).isNegative()) || (tax && dec(tax).isNegative())) throw new Error("negative");
    if (gross && dec(gross).lessThan(net)) throw new Error("gross below net");
  } catch {
    return fail("validation", "Gross, net, and tax/withholding must be valid non-negative amounts, and gross cannot be below net.");
  }
  const verificationStatus = input.verificationStatus ?? "verified";
  if (!(["unverified", "verified", "void"] as const).includes(verificationStatus)) {
    return fail("validation", "Choose a valid verification status.");
  }

  return inTransaction(pool, async (client) => {
    const previous = input.id
      ? await client.query<Record<string, unknown>>(`SELECT * FROM employee_payroll_checks WHERE id = $1 FOR UPDATE`, [input.id])
      : null;
    if (input.id && !previous?.rows[0]) return fail("not_found", "That payroll check no longer exists.");
    if (previous?.rows[0] && previous.rows[0].employee_id !== input.employeeId) {
      return fail("validation", "A payroll check cannot be moved to another employee.");
    }
    const saved = input.id
      ? await client.query<{ id: string }>(
          `UPDATE employee_payroll_checks
              SET check_number = $2, check_date = $3::date, period_begin = $4::date,
                  period_end = $5::date, actual_gross = $6, actual_net = $7,
                  tax_withheld = $8, source_ref = $9, verification_status = $10,
                  notes = $11, updated_by_user_id = $12, updated_at = now()
            WHERE id = $1 RETURNING id`,
          [input.id, checkNumber, checkDate, periodBegin, periodEnd, gross, net, tax, optionalText(input.sourceRef), verificationStatus, optionalText(input.notes), actorId],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO employee_payroll_checks
             (employee_id, check_number, check_date, period_begin, period_end,
              actual_gross, actual_net, tax_withheld, source, source_ref,
              verification_status, notes, created_by_user_id, updated_by_user_id)
           VALUES ($1, $2, $3::date, $4::date, $5::date, $6, $7, $8,
                   'manual', $9, $10, $11, $12, $12)
           RETURNING id`,
          [input.employeeId, checkNumber, checkDate, periodBegin, periodEnd, gross, net, tax, optionalText(input.sourceRef), verificationStatus, optionalText(input.notes), actorId],
        );
    const id = saved.rows[0].id;
    if (verificationStatus === "void") {
      await client.query(
        `UPDATE payroll_transactions
            SET payroll_check_id = NULL, updated_at = now()
          WHERE payroll_check_id = $1`,
        [id],
      );
    } else {
      const priorPeriodBegin = storedDate(previous?.rows[0]?.period_begin);
      const priorPeriodEnd = storedDate(previous?.rows[0]?.period_end);
      const periodMoved = previous?.rows[0]
        && (priorPeriodBegin !== periodBegin || priorPeriodEnd !== periodEnd);
      if (periodMoved) {
        await client.query(
          `UPDATE payroll_transactions
              SET payroll_check_id = NULL, updated_at = now()
            WHERE payroll_check_id = $1`,
          [id],
        );
      }
      // Keep an existing check's links when only its number/date is corrected,
      // and attach any unlinked rows that match the strongest supplied identity.
      await client.query(
           `UPDATE payroll_transactions t
               SET payroll_check_id = $1, updated_at = now()
             WHERE t.employee_id = $2
               AND effective_payment_recipient(
                 t.payment_recipient,
                 (SELECT p.payment_recipient FROM programs p WHERE p.id = t.program_id)
               ) = 'employee'
               AND (t.payroll_check_id IS NULL OR t.payroll_check_id = $1)
              AND (
                ($5::date IS NOT NULL AND t.period_begin = $5::date
                    AND ($6::date IS NULL OR t.period_end = $6::date))
                OR ($5::date IS NULL AND $6::date IS NOT NULL AND t.period_end = $6::date)
                OR ($5::date IS NULL AND $6::date IS NULL
                    AND $3::text IS NOT NULL
                    AND NULLIF(btrim(t.check_number), '') = $3
                    AND ($4::date IS NULL OR t.check_date = $4::date))
                OR ($5::date IS NULL AND $6::date IS NULL AND $3::text IS NULL
                    AND $4::date IS NOT NULL AND t.check_date = $4::date)
              )`,
        [id, input.employeeId, checkNumber, checkDate, periodBegin, periodEnd],
      );
    }
    const linked = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM payroll_transactions
        WHERE payroll_check_id = $1`,
      [id],
    );
    const linkedTransactions = Number(linked.rows[0]?.count ?? 0);
    await recordChange(client, {
      actorId,
      action: input.id ? "payroll_check.updated" : "payroll_check.created",
      entityType: "employee_payroll_check",
      entityId: id,
      previous: previous?.rows[0] ?? undefined,
      next: { employeeId: input.employeeId, checkNumber, checkDate, periodBegin, periodEnd, actualGross: gross, actualNet: net, taxWithheld: tax, verificationStatus, linkedTransactions },
    });
    return ok({ id, linkedTransactions });
  });
}

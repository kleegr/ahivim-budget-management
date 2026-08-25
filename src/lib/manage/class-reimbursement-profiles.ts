import { isIsoCalendarDate } from "@/lib/business/class-invoicing";
import {
  getClassCoverSheetSnapshot,
  getClassReimbursementProfile,
  type ClassReimbursementProfile,
} from "@/lib/data/class-reimbursement-profiles";
import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClassReimbursementProfileInput {
  mailingName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  cityStateZip?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  medicaidId?: string | null;
  fiscalIntermediary?: string | null;
  payableTo?: string | null;
  lifePlanConfirmed?: boolean;
  budgetCategory?: string | null;
  formCompletedBy?: string | null;
  relationship?: string | null;
}

const clean = (value: string | null | undefined): string | null => value?.trim() || null;

export async function saveClassReimbursementProfile(
  pool: PgLikePool,
  individualId: string,
  input: ClassReimbursementProfileInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<ClassReimbursementProfile>> {
  if (!UUID.test(individualId)) return fail("not_found", "That individual was not found.");
  const dateOfBirth = clean(input.dateOfBirth);
  if (dateOfBirth && !isIsoCalendarDate(dateOfBirth)) {
    return fail("validation", "Enter a valid date of birth.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const individual = await client.query<{ id: string }>(
      `SELECT id FROM individuals WHERE id = $1 FOR UPDATE`,
      [individualId],
    );
    if (!individual.rows[0]) {
      await client.query("ROLLBACK");
      return fail("not_found", "That individual was not found.");
    }
    const existing = await getClassReimbursementProfile(client, individualId);
    if (!existing) {
      await client.query("ROLLBACK");
      return fail("not_found", "That individual was not found.");
    }
    const next = {
      mailingName: input.mailingName === undefined ? existing.mailingName : clean(input.mailingName),
      addressLine1: input.addressLine1 === undefined ? existing.addressLine1 : clean(input.addressLine1),
      addressLine2: input.addressLine2 === undefined ? existing.addressLine2 : clean(input.addressLine2),
      cityStateZip: input.cityStateZip === undefined ? existing.cityStateZip : clean(input.cityStateZip),
      phone: input.phone === undefined ? existing.phone : clean(input.phone),
      dateOfBirth: input.dateOfBirth === undefined ? existing.dateOfBirth : dateOfBirth,
      medicaidId: input.medicaidId === undefined ? existing.medicaidId : clean(input.medicaidId),
      fiscalIntermediary: input.fiscalIntermediary === undefined
        ? existing.fiscalIntermediary
        : clean(input.fiscalIntermediary) ?? "Ahivim",
      payableTo: input.payableTo === undefined
        ? existing.payableTo
        : clean(input.payableTo) ?? "Xcellent Staffing",
      lifePlanConfirmed: input.lifePlanConfirmed === undefined
        ? existing.lifePlanConfirmed
        : input.lifePlanConfirmed === true,
      budgetCategory: input.budgetCategory === undefined
        ? existing.budgetCategory
        : clean(input.budgetCategory) ?? "Community classes",
      formCompletedBy: input.formCompletedBy === undefined
        ? existing.formCompletedBy
        : clean(input.formCompletedBy),
      relationship: input.relationship === undefined ? existing.relationship : clean(input.relationship),
    };
    await client.query(
      `INSERT INTO class_reimbursement_profiles
         (individual_id, mailing_name, address_line_1, address_line_2,
          city_state_zip, phone, date_of_birth, medicaid_id,
          fiscal_intermediary, payable_to, life_plan_confirmed, budget_category,
          form_completed_by, relationship, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
       ON CONFLICT (individual_id) DO UPDATE SET
         mailing_name = EXCLUDED.mailing_name,
         address_line_1 = EXCLUDED.address_line_1,
         address_line_2 = EXCLUDED.address_line_2,
         city_state_zip = EXCLUDED.city_state_zip,
         phone = EXCLUDED.phone,
         date_of_birth = EXCLUDED.date_of_birth,
         medicaid_id = EXCLUDED.medicaid_id,
         fiscal_intermediary = EXCLUDED.fiscal_intermediary,
         payable_to = EXCLUDED.payable_to,
         life_plan_confirmed = EXCLUDED.life_plan_confirmed,
         budget_category = EXCLUDED.budget_category,
         form_completed_by = EXCLUDED.form_completed_by,
         relationship = EXCLUDED.relationship,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()`,
      [
        individualId,
        next.mailingName,
        next.addressLine1,
        next.addressLine2,
        next.cityStateZip,
        next.phone,
        next.dateOfBirth,
        next.medicaidId,
        next.fiscalIntermediary,
        next.payableTo,
        next.lifePlanConfirmed,
        next.budgetCategory,
        next.formCompletedBy,
        next.relationship,
        actorId,
      ],
    );

    // Keep the sensitive values in their restricted table; general audit
    // metadata records only that a configured profile changed.
    await recordChange(client, {
      actorId,
      action: "class_reimbursement_profile_saved",
      entityType: "individual",
      entityId: individualId,
      previous: { configured: existing.id !== null },
      next: { configured: true },
      reason,
    });
    const saved = await getClassReimbursementProfile(client, individualId);
    await client.query("COMMIT");
    return ok(saved!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createClassCoverSheetSnapshot(
  pool: PgLikePool,
  invoiceId: string,
  profile: ClassReimbursementProfile,
  actorId: string,
): Promise<Result<ClassReimbursementProfile>> {
  if (!UUID.test(invoiceId)) return fail("not_found", "That class invoice was not found.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await getClassCoverSheetSnapshot(client, invoiceId);
    if (existing) {
      await client.query("COMMIT");
      return ok(existing);
    }
    if (!profile.lifePlanConfirmed) {
      await client.query("ROLLBACK");
      return fail("validation", "Confirm that the class expense is listed in the Life Plan before creating the cover sheet.");
    }
    const invoice = await client.query<{ individual_id: string; status: string }>(
      `SELECT individual_id, status FROM class_invoices WHERE id = $1 FOR UPDATE`,
      [invoiceId],
    );
    if (!invoice.rows[0] || invoice.rows[0].status !== "issued") {
      await client.query("ROLLBACK");
      return fail("conflict", "Only an issued class invoice can have a cover sheet.");
    }
    if (invoice.rows[0].individual_id !== profile.individualId) {
      await client.query("ROLLBACK");
      return fail("conflict", "The reimbursement profile does not match this invoice.");
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO class_cover_sheet_snapshots
         (class_invoice_id, profile_snapshot, created_by_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (class_invoice_id) DO NOTHING
       RETURNING id`,
      [invoiceId, JSON.stringify(profile), actorId],
    );
    if (inserted.rows[0]) {
      await recordChange(client, {
        actorId,
        action: "class_cover_sheet_created",
        entityType: "class_invoice",
        entityId: invoiceId,
        next: { snapshotCreated: true },
      });
    }
    const snapshot = await getClassCoverSheetSnapshot(client, invoiceId);
    await client.query("COMMIT");
    return snapshot ? ok(snapshot) : fail("conflict", "Could not freeze the reimbursement cover details.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

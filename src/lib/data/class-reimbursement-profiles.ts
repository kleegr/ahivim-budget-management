import type { PgLikePool } from "@/lib/import/commit";

type Queryable = Pick<PgLikePool, "query">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClassReimbursementProfile {
  id: string | null;
  individualId: string;
  individualName: string;
  mailingName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  cityStateZip: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  medicaidId: string | null;
  fiscalIntermediary: string;
  payableTo: string;
  lifePlanConfirmed: boolean;
  budgetCategory: string;
  formCompletedBy: string | null;
  relationship: string | null;
  updatedAt: string | null;
}

interface ProfileRow {
  id: string | null;
  individual_id: string;
  individual_name: string;
  mailing_name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city_state_zip: string | null;
  phone: string | null;
  date_of_birth: string | null;
  medicaid_id: string | null;
  fiscal_intermediary: string | null;
  payable_to: string | null;
  life_plan_confirmed: boolean | null;
  budget_category: string | null;
  form_completed_by: string | null;
  relationship: string | null;
  updated_at: string | null;
}

function mapProfile(row: ProfileRow): ClassReimbursementProfile {
  return {
    id: row.id,
    individualId: row.individual_id,
    individualName: row.individual_name,
    mailingName: row.mailing_name,
    addressLine1: row.address_line_1,
    addressLine2: row.address_line_2,
    cityStateZip: row.city_state_zip,
    phone: row.phone,
    dateOfBirth: row.date_of_birth,
    medicaidId: row.medicaid_id,
    fiscalIntermediary: row.fiscal_intermediary ?? "Ahivim",
    payableTo: row.payable_to ?? "Xcellent Staffing",
    lifePlanConfirmed: row.life_plan_confirmed ?? false,
    budgetCategory: row.budget_category ?? "Community classes",
    formCompletedBy: row.form_completed_by,
    relationship: row.relationship,
    updatedAt: row.updated_at,
  };
}

/** Returns a usable blank profile even before staff save optional cover details. */
export async function getClassReimbursementProfile(
  pool: Queryable,
  individualId: string,
): Promise<ClassReimbursementProfile | null> {
  if (!UUID.test(individualId)) return null;
  const { rows } = await pool.query<ProfileRow>(
    `SELECT profile.id, individual.id AS individual_id,
            individual.display_name AS individual_name,
            profile.mailing_name, profile.address_line_1, profile.address_line_2,
            profile.city_state_zip, profile.phone,
            profile.date_of_birth::text AS date_of_birth, profile.medicaid_id,
            profile.fiscal_intermediary, profile.payable_to,
            profile.life_plan_confirmed, profile.budget_category,
            profile.form_completed_by, profile.relationship,
            profile.updated_at::text AS updated_at
       FROM individuals individual
       LEFT JOIN class_reimbursement_profiles profile
         ON profile.individual_id = individual.id
      WHERE individual.id = $1`,
    [individualId],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function getClassCoverSheetSnapshot(
  pool: Queryable,
  invoiceId: string,
): Promise<ClassReimbursementProfile | null> {
  if (!UUID.test(invoiceId)) return null;
  const { rows } = await pool.query<{ profile_snapshot: ClassReimbursementProfile }>(
    `SELECT profile_snapshot
       FROM class_cover_sheet_snapshots
      WHERE class_invoice_id = $1`,
    [invoiceId],
  );
  return rows[0]?.profile_snapshot ?? null;
}

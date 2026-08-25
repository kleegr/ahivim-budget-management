import type { AccessScope } from "@/lib/auth/access";
import type { PgLikePool } from "@/lib/import/commit";
import { toMoney } from "@/lib/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function directIndividualClause(
  scope: AccessScope,
  column: string,
  params: unknown[],
): string {
  if (!scope.canSeeClassFinancials) return " AND FALSE";
  if (scope.full || scope.allIndividuals) return "";
  if (scope.grantedIndividualIds.length === 0) return " AND FALSE";
  params.push(scope.grantedIndividualIds);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

export interface ClassActivityRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultUnitPrice: string;
  isActive: boolean;
  sortOrder: number;
}

interface ActivityRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_unit_price: string;
  is_active: boolean;
  sort_order: number;
}

const toActivity = (row: ActivityRow): ClassActivityRecord => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  defaultUnitPrice: toMoney(row.default_unit_price),
  isActive: row.is_active,
  sortOrder: row.sort_order,
});

/** Activity prices are financial configuration, so a planner gets no rows. */
export async function listClassActivities(
  pool: PgLikePool,
  scope: AccessScope,
  includeInactive = false,
): Promise<ClassActivityRecord[]> {
  if (!scope.canSeeClassFinancials) return [];
  const { rows } = await pool.query<ActivityRow>(
    `SELECT id, code, name, description, default_unit_price::text AS default_unit_price,
            is_active, sort_order
       FROM class_activities
      WHERE ($1::boolean OR is_active)
      ORDER BY sort_order, name, id`,
    [includeInactive],
  );
  return rows.map(toActivity);
}

/** Internal lookup used while validating draft lines. */
export async function getClassActivitiesByIds(
  pool: PgLikePool,
  ids: readonly string[],
): Promise<Map<string, ClassActivityRecord>> {
  const valid = [...new Set(ids)].filter((id) => UUID.test(id));
  if (valid.length === 0) return new Map();
  const { rows } = await pool.query<ActivityRow>(
    `SELECT id, code, name, description, default_unit_price::text AS default_unit_price,
            is_active, sort_order
       FROM class_activities
      WHERE id = ANY($1::uuid[]) AND is_active`,
    [valid],
  );
  return new Map(rows.map((row) => [row.id, toActivity(row)]));
}

export interface ClassBudgetRecord {
  id: string;
  individualId: string;
  individualName: string;
  label: string;
  startDate: string;
  endDate: string;
  authorizedAmount: string;
  consumedAmount: string;
  remainingAmount: string;
  status: "active" | "closed";
  notes: string | null;
  invoiceCount: number;
  lastInvoiceDate: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BudgetRow {
  id: string;
  individual_id: string;
  individual_name: string;
  label: string;
  start_date: string;
  end_date: string;
  authorized_amount: string;
  consumed_amount: string;
  remaining_amount: string;
  status: "active" | "closed";
  notes: string | null;
  invoice_count: string;
  last_invoice_date: string | null;
  created_at: string;
  updated_at: string;
}

const BUDGET_SELECT = `
  SELECT b.id, b.individual_id, i.display_name AS individual_name,
         b.label, b.start_date::text AS start_date, b.end_date::text AS end_date,
         b.authorized_amount::text AS authorized_amount,
         COALESCE(bb.consumed_amount, 0)::text AS consumed_amount,
         COALESCE(bb.remaining_amount, b.authorized_amount)::text AS remaining_amount,
         b.status, b.notes,
         count(inv.id)::text AS invoice_count,
         max(inv.invoice_date)::text AS last_invoice_date,
         b.created_at::text AS created_at, b.updated_at::text AS updated_at
    FROM class_budget_periods b
    JOIN individuals i ON i.id = b.individual_id
    LEFT JOIN class_budget_balances bb ON bb.class_budget_period_id = b.id
    LEFT JOIN class_invoices inv ON inv.class_budget_period_id = b.id
`;

const toBudget = (row: BudgetRow): ClassBudgetRecord => ({
  id: row.id,
  individualId: row.individual_id,
  individualName: row.individual_name,
  label: row.label,
  startDate: row.start_date,
  endDate: row.end_date,
  authorizedAmount: toMoney(row.authorized_amount),
  consumedAmount: toMoney(row.consumed_amount),
  remainingAmount: toMoney(row.remaining_amount),
  status: row.status,
  notes: row.notes,
  invoiceCount: Number(row.invoice_count),
  lastInvoiceDate: row.last_invoice_date,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function listClassBudgets(
  pool: PgLikePool,
  scope: AccessScope,
  filters: { individualId?: string | null; status?: "active" | "closed" | null } = {},
): Promise<ClassBudgetRecord[]> {
  const params: unknown[] = [];
  const where: string[] = ["TRUE"];
  if (filters.individualId && UUID.test(filters.individualId)) {
    params.push(filters.individualId);
    where.push(`b.individual_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`b.status = $${params.length}`);
  }
  const scoped = directIndividualClause(scope, "b.individual_id", params);
  const { rows } = await pool.query<BudgetRow>(
    `${BUDGET_SELECT}
      WHERE ${where.join(" AND ")}${scoped}
      GROUP BY b.id, i.display_name, bb.consumed_amount, bb.remaining_amount
      ORDER BY b.start_date DESC, i.display_name, b.id`,
    params,
  );
  return rows.map(toBudget);
}

export async function getClassBudget(
  pool: PgLikePool,
  id: string,
): Promise<ClassBudgetRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query<BudgetRow>(
    `${BUDGET_SELECT}
      WHERE b.id = $1
      GROUP BY b.id, i.display_name, bb.consumed_amount, bb.remaining_amount`,
    [id],
  );
  return rows[0] ? toBudget(rows[0]) : null;
}

export interface ClassInvoiceLineRecord {
  id: string;
  activityId: string | null;
  activityCode: string | null;
  serviceDate: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  lineTotal: string;
  sortOrder: number;
  notes: string | null;
}

export interface ClassInvoiceRecord {
  id: string;
  classBudgetPeriodId: string;
  individualId: string;
  individualName: string;
  budgetLabel: string;
  invoiceNumber: string;
  invoiceDate: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  billToName: string;
  billToAddressLine1: string | null;
  billToAddressLine2: string | null;
  billToCityStateZip: string | null;
  purpose: string;
  notes: string | null;
  status: "draft" | "issued" | "void";
  subtotal: string;
  discountTotal: string;
  totalAmount: string;
  budgetAuthorizedSnapshot: string | null;
  budgetConsumedBeforeSnapshot: string | null;
  budgetOverageSnapshot: string | null;
  overBudgetOverrideReason: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
  lines: ClassInvoiceLineRecord[];
}

type InvoiceHeaderRow = {
  id: string;
  class_budget_period_id: string;
  individual_id: string;
  individual_name: string;
  budget_label: string;
  invoice_number: string;
  invoice_date: string;
  service_period_start: string;
  service_period_end: string;
  bill_to_name: string;
  bill_to_address_line_1: string | null;
  bill_to_address_line_2: string | null;
  bill_to_city_state_zip: string | null;
  purpose: string;
  notes: string | null;
  status: "draft" | "issued" | "void";
  subtotal: string;
  discount_total: string;
  total_amount: string;
  budget_authorized_snapshot: string | null;
  budget_consumed_before_snapshot: string | null;
  budget_overage_snapshot: string | null;
  over_budget_override_reason: string | null;
  issued_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};

const INVOICE_SELECT = `
  SELECT inv.id, inv.class_budget_period_id, inv.individual_id,
         i.display_name AS individual_name, b.label AS budget_label,
         inv.invoice_number, inv.invoice_date::text AS invoice_date,
         inv.service_period_start::text AS service_period_start,
         inv.service_period_end::text AS service_period_end,
         inv.bill_to_name, inv.bill_to_address_line_1, inv.bill_to_address_line_2,
         inv.bill_to_city_state_zip, inv.purpose, inv.notes, inv.status,
         inv.subtotal::text AS subtotal, inv.discount_total::text AS discount_total,
         inv.total_amount::text AS total_amount,
         inv.budget_authorized_snapshot::text AS budget_authorized_snapshot,
         inv.budget_consumed_before_snapshot::text AS budget_consumed_before_snapshot,
         inv.budget_overage_snapshot::text AS budget_overage_snapshot,
         inv.over_budget_override_reason,
         inv.issued_at::text AS issued_at, inv.voided_at::text AS voided_at,
         inv.void_reason, inv.created_at::text AS created_at, inv.updated_at::text AS updated_at
    FROM class_invoices inv
    JOIN class_budget_periods b ON b.id = inv.class_budget_period_id
    JOIN individuals i ON i.id = inv.individual_id
`;

function invoiceHeader(row: InvoiceHeaderRow): Omit<ClassInvoiceRecord, "lines"> {
  return {
    id: row.id,
    classBudgetPeriodId: row.class_budget_period_id,
    individualId: row.individual_id,
    individualName: row.individual_name,
    budgetLabel: row.budget_label,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    servicePeriodStart: row.service_period_start,
    servicePeriodEnd: row.service_period_end,
    billToName: row.bill_to_name,
    billToAddressLine1: row.bill_to_address_line_1,
    billToAddressLine2: row.bill_to_address_line_2,
    billToCityStateZip: row.bill_to_city_state_zip,
    purpose: row.purpose,
    notes: row.notes,
    status: row.status,
    subtotal: toMoney(row.subtotal),
    discountTotal: toMoney(row.discount_total),
    totalAmount: toMoney(row.total_amount),
    budgetAuthorizedSnapshot: row.budget_authorized_snapshot === null
      ? null
      : toMoney(row.budget_authorized_snapshot),
    budgetConsumedBeforeSnapshot: row.budget_consumed_before_snapshot === null
      ? null
      : toMoney(row.budget_consumed_before_snapshot),
    budgetOverageSnapshot: row.budget_overage_snapshot === null
      ? null
      : toMoney(row.budget_overage_snapshot),
    overBudgetOverrideReason: row.over_budget_override_reason,
    issuedAt: row.issued_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listClassInvoices(
  pool: PgLikePool,
  scope: AccessScope,
  filters: {
    individualId?: string | null;
    budgetId?: string | null;
    status?: "draft" | "issued" | "void" | null;
  } = {},
): Promise<Array<Omit<ClassInvoiceRecord, "lines">>> {
  const params: unknown[] = [];
  const where: string[] = ["TRUE"];
  if (filters.individualId && UUID.test(filters.individualId)) {
    params.push(filters.individualId);
    where.push(`inv.individual_id = $${params.length}`);
  }
  if (filters.budgetId && UUID.test(filters.budgetId)) {
    params.push(filters.budgetId);
    where.push(`inv.class_budget_period_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`inv.status = $${params.length}`);
  }
  const scoped = directIndividualClause(scope, "inv.individual_id", params);
  const { rows } = await pool.query<InvoiceHeaderRow>(
    `${INVOICE_SELECT}
      WHERE ${where.join(" AND ")}${scoped}
      ORDER BY inv.invoice_date DESC, inv.created_at DESC, inv.id`,
    params,
  );
  return rows.map(invoiceHeader);
}

export async function getClassInvoice(
  pool: PgLikePool,
  id: string,
): Promise<ClassInvoiceRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query<InvoiceHeaderRow>(`${INVOICE_SELECT} WHERE inv.id = $1`, [id]);
  if (!rows[0]) return null;
  const lineResult = await pool.query<{
    id: string;
    class_activity_id: string | null;
    activity_code: string | null;
    service_date: string;
    description: string;
    quantity: string;
    unit_price: string;
    discount_amount: string;
    line_total: string;
    sort_order: number;
    notes: string | null;
  }>(
    `SELECT line.id, line.class_activity_id, activity.code AS activity_code,
            line.service_date::text AS service_date, line.description,
            line.quantity::text AS quantity, line.unit_price::text AS unit_price,
            line.discount_amount::text AS discount_amount,
            line.line_total::text AS line_total, line.sort_order, line.notes
       FROM class_invoice_lines line
       LEFT JOIN class_activities activity ON activity.id = line.class_activity_id
      WHERE line.class_invoice_id = $1
      ORDER BY line.sort_order, line.service_date, line.id`,
    [id],
  );
  return {
    ...invoiceHeader(rows[0]),
    lines: lineResult.rows.map((line) => ({
      id: line.id,
      activityId: line.class_activity_id,
      activityCode: line.activity_code,
      serviceDate: line.service_date,
      description: line.description,
      quantity: line.quantity,
      unitPrice: toMoney(line.unit_price),
      discountAmount: toMoney(line.discount_amount),
      lineTotal: toMoney(line.line_total),
      sortOrder: line.sort_order,
      notes: line.notes,
    })),
  };
}

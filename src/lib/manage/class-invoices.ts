import {
  isIsoCalendarDate,
  isSaturday,
  prepareClassInvoiceLines,
  type ClassActivityPricing,
  type ClassInvoiceLineInput,
} from "@/lib/business/class-invoicing";
import {
  getClassBudget,
  getClassInvoice,
  type ClassActivityRecord,
  type ClassBudgetRecord,
  type ClassInvoiceRecord,
} from "@/lib/data/class-invoices";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec, toHours, toMoney } from "@/lib/money";
import { recordChange } from "./audit";
import { ok, type ResultCode } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITY_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

/** Mirror a class invoice lifecycle into the canonical program budget ledger. */
async function postClassProgramBudgetIssue(
  client: PgLikeClient,
  classBudgetPeriodId: string,
  classInvoiceId: string,
  serviceDate: string,
  amount: string,
  actorId: string,
): Promise<void> {
  const link = await client.query<{
    budget_period_id: string | null;
    individual_id: string;
    program_id: string | null;
  }>(
    `SELECT budget_period_id, individual_id, program_id
       FROM class_budget_periods WHERE id = $1`,
    [classBudgetPeriodId],
  );
  const budget = link.rows[0];
  if (!budget?.budget_period_id || !budget.program_id) {
    throw new Error("Class budget is missing its canonical program authorization link.");
  }
  await client.query(
    `INSERT INTO program_budget_events
       (budget_period_id, individual_id, program_id, event_type, service_date,
        hours, amount, source_type, source_id, note, created_by_user_id)
     VALUES ($1, $2, $3, 'consume', $4, 0, $5, 'class_invoice', $6,
             'Issued class invoice.', $7)
     ON CONFLICT (source_type, source_id, event_type) DO NOTHING`,
    [budget.budget_period_id, budget.individual_id, budget.program_id, serviceDate, amount, classInvoiceId, actorId],
  );
  const existing = await client.query<{
    budget_period_id: string;
    program_id: string;
    amount: string;
  }>(
    `SELECT budget_period_id, program_id, amount::text AS amount
       FROM program_budget_events
      WHERE source_type = 'class_invoice' AND source_id = $1 AND event_type = 'consume'`,
    [classInvoiceId],
  );
  if (!existing.rows[0]
      || existing.rows[0].budget_period_id !== budget.budget_period_id
      || existing.rows[0].program_id !== budget.program_id
      || !dec(existing.rows[0].amount).eq(amount)) {
    throw new Error("Class invoice program-budget issue link is inconsistent.");
  }
}

async function postClassProgramBudgetReversal(
  client: PgLikeClient,
  classInvoiceId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const original = await client.query<{
    id: string;
    budget_period_id: string;
    individual_id: string;
    program_id: string;
    service_date: string;
    hours: string;
    amount: string;
    source_type: string;
    source_id: string;
  }>(
    `SELECT id, budget_period_id, individual_id, program_id,
            service_date::text AS service_date, hours::text AS hours,
            amount::text AS amount, source_type, source_id
       FROM program_budget_events
      WHERE source_type = 'class_invoice' AND source_id = $1 AND event_type = 'consume'
      FOR UPDATE`,
    [classInvoiceId],
  );
  const source = original.rows[0];
  if (!source) {
    throw new Error("Class invoice is missing its canonical program-budget issue event.");
  }
  await client.query(
    `INSERT INTO program_budget_events
       (budget_period_id, individual_id, program_id, event_type, service_date,
        hours, amount, source_type, source_id, reverses_event_id, note, created_by_user_id)
     VALUES ($1, $2, $3, 'reverse', $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (source_type, source_id, event_type) DO NOTHING`,
    [
      source.budget_period_id,
      source.individual_id,
      source.program_id,
      source.service_date,
      toHours(dec(source.hours).negated()),
      toMoney(dec(source.amount).negated()),
      source.source_type,
      source.source_id,
      source.id,
      reason,
      actorId,
    ],
  );
  const reversal = await client.query<{ reverses_event_id: string }>(
    `SELECT reverses_event_id FROM program_budget_events
      WHERE source_type = 'class_invoice' AND source_id = $1 AND event_type = 'reverse'`,
    [classInvoiceId],
  );
  if (reversal.rows[0]?.reverses_event_id !== source.id) {
    throw new Error("Class invoice program-budget reversal link is inconsistent.");
  }
}

export type ClassOperationResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: ResultCode;
      message: string;
      details?: ClassBudgetOverageDetails;
    };

export interface ClassBudgetOverageDetails {
  kind: "class_budget_overage";
  authorizedAmount: string;
  consumedAmount: string;
  invoiceAmount: string;
  projectedAmount: string;
  overageAmount: string;
}

const classFail = (
  code: ResultCode,
  message: string,
  details?: ClassBudgetOverageDetails,
): ClassOperationResult<never> => ({ ok: false, code, message, ...(details ? { details } : {}) });

async function activityById(db: Queryable, id: string): Promise<ClassActivityRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    default_unit_price: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT id, code, name, description, default_unit_price::text AS default_unit_price,
            is_active, sort_order
       FROM class_activities WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    defaultUnitPrice: toMoney(row.default_unit_price),
    isActive: row.is_active,
    sortOrder: row.sort_order,
  } : null;
}

export interface SaveClassActivityInput {
  code: string;
  name: string;
  description?: string | null;
  defaultUnitPrice?: string | null;
  isActive?: boolean;
  sortOrder?: number | null;
}

function validatedActivity(input: SaveClassActivityInput):
  | { ok: true; value: Required<Pick<SaveClassActivityInput, "code" | "name" | "isActive" | "sortOrder">> & {
      description: string | null;
      defaultUnitPrice: string;
    } }
  | { ok: false; message: string } {
  const code = input.code?.trim().toUpperCase() || "";
  const name = input.name?.trim() || "";
  if (!ACTIVITY_CODE.test(code)) {
    return { ok: false, message: "Activity code may use letters, numbers, dashes, and underscores." };
  }
  if (!name || name.length > 120) return { ok: false, message: "Give the class activity a name." };
  try {
    const price = dec(input.defaultUnitPrice ?? "150");
    if (!price.isFinite() || price.lt(0)) {
      return { ok: false, message: "Default class price must be zero or more." };
    }
    return {
      ok: true,
      value: {
        code,
        name,
        description: input.description?.trim() || null,
        defaultUnitPrice: toMoney(price),
        isActive: input.isActive !== false,
        sortOrder: Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 0,
      },
    };
  } catch {
    return { ok: false, message: "Enter a valid default class price." };
  }
}

export async function createClassActivity(
  pool: PgLikePool,
  input: SaveClassActivityInput,
  actorId: string,
  reason?: string | null,
): Promise<ClassOperationResult<ClassActivityRecord>> {
  const parsed = validatedActivity(input);
  if (!parsed.ok) return classFail("validation", parsed.message);
  const value = parsed.value;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(
      `SELECT 1 FROM class_activities WHERE lower(code) = lower($1)`,
      [value.code],
    );
    if (duplicate.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("conflict", "That class activity code is already in use.");
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO class_activities
         (code, name, description, default_unit_price, is_active, sort_order,
          created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [value.code, value.name, value.description, value.defaultUnitPrice, value.isActive, value.sortOrder, actorId],
    );
    const record = await activityById(client, rows[0]!.id);
    await recordChange(client, {
      actorId,
      action: "class_activity_created",
      entityType: "class_activity",
      entityId: rows[0]!.id,
      next: record,
      reason,
    });
    await client.query("COMMIT");
    return ok(record!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateClassActivity(
  pool: PgLikePool,
  id: string,
  input: SaveClassActivityInput,
  actorId: string,
  reason?: string | null,
): Promise<ClassOperationResult<ClassActivityRecord>> {
  if (!UUID.test(id)) return classFail("not_found", "That class activity no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`SELECT id FROM class_activities WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class activity no longer exists.");
    }
    const before = await activityById(client, id);
    if (!before) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class activity no longer exists.");
    }
    const parsed = validatedActivity(input);
    if (!parsed.ok) {
      await client.query("ROLLBACK");
      return classFail("validation", parsed.message);
    }
    const value = parsed.value;
    const duplicate = await client.query(
      `SELECT 1 FROM class_activities WHERE lower(code) = lower($1) AND id <> $2`,
      [value.code, id],
    );
    if (duplicate.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("conflict", "That class activity code is already in use.");
    }
    await client.query(
      `UPDATE class_activities
          SET code = $1, name = $2, description = $3, default_unit_price = $4,
              is_active = $5, sort_order = $6, updated_by_user_id = $7, updated_at = now()
        WHERE id = $8`,
      [value.code, value.name, value.description, value.defaultUnitPrice, value.isActive, value.sortOrder, actorId, id],
    );
    const record = await activityById(client, id);
    await recordChange(client, {
      actorId,
      action: "class_activity_updated",
      entityType: "class_activity",
      entityId: id,
      previous: before,
      next: record,
      reason,
    });
    await client.query("COMMIT");
    return ok(record!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface CreateClassBudgetInput {
  individualId: string;
  label?: string | null;
  startDate: string;
  endDate: string;
  authorizedAmount: string;
  notes?: string | null;
}

function validateBudgetInput(input: CreateClassBudgetInput): string | null {
  if (!UUID.test(input.individualId)) return "Choose an individual.";
  if (!isIsoCalendarDate(input.startDate) || !isIsoCalendarDate(input.endDate)) {
    return "Give valid start and end dates for the class budget.";
  }
  if (input.endDate < input.startDate) return "The class budget end date is before its start date.";
  try {
    if (dec(input.authorizedAmount).lt(0)) return "The class budget amount cannot be negative.";
  } catch {
    return "Enter a valid class budget amount.";
  }
  return null;
}

export async function createClassBudget(
  pool: PgLikePool,
  input: CreateClassBudgetInput,
  actorId: string,
  reason?: string | null,
): Promise<ClassOperationResult<ClassBudgetRecord>> {
  const validation = validateBudgetInput(input);
  if (validation) return classFail("validation", validation);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const person = await client.query<{ display_name: string }>(
      `SELECT display_name FROM individuals WHERE id = $1 FOR UPDATE`,
      [input.individualId],
    );
    if (!person.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That individual no longer exists.");
    }
    const overlap = await client.query(
      `SELECT 1 FROM class_budget_periods
        WHERE individual_id = $1 AND status = 'active'
          AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
        LIMIT 1`,
      [input.individualId, input.startDate, input.endDate],
    );
    if (overlap.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("conflict", "This individual already has an active class budget covering part of that period.");
    }
    const label = input.label?.trim() || `${input.startDate} to ${input.endDate}`;
    const program = await client.query<{ id: string }>(
      `SELECT id FROM programs WHERE code = 'CLASSES' AND is_active FOR SHARE`,
    );
    if (!program.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("conflict", "The Classes service program is not available.");
    }
    const period = await client.query<{ id: string }>(
      `INSERT INTO budget_periods
         (individual_id, label, start_date, end_date, period_type, renewal_date,
          status, source, notes)
       VALUES ($1, $2, $3, $4, 'custom', ($4::date + 1), 'active',
               'class_bridge', $5)
       RETURNING id`,
      [input.individualId, label, input.startDate, input.endDate, input.notes?.trim() || null],
    );
    const authorization = await client.query<{ id: string }>(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours,
          internal_rate, authorized_dollars, rate_basis, revision, status,
          source, notes, created_by_user_id)
       VALUES ($1, $2, $3, 0, 0, $4, 'dollars', 1, 'active',
               'class_bridge', $5, $6)
       RETURNING id`,
      [
        period.rows[0]!.id,
        input.individualId,
        program.rows[0].id,
        toMoney(input.authorizedAmount),
        input.notes?.trim() || null,
        actorId,
      ],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO class_budget_periods
         (individual_id, label, start_date, end_date, authorized_amount, notes,
          program_id, budget_period_id, budget_authorization_id,
          created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING id`,
      [
        input.individualId,
        label,
        input.startDate,
        input.endDate,
        toMoney(input.authorizedAmount),
        input.notes?.trim() || null,
        program.rows[0].id,
        period.rows[0]!.id,
        authorization.rows[0]!.id,
        actorId,
      ],
    );
    await recordChange(client, {
      actorId,
      action: "class_budget_created",
      entityType: "class_budget",
      entityId: rows[0]!.id,
      next: { ...input, label, authorizedAmount: toMoney(input.authorizedAmount) },
      reason,
    });
    await client.query("COMMIT");
    return ok((await getClassBudget(pool, rows[0]!.id))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface UpdateClassBudgetInput {
  label?: string | null;
  authorizedAmount?: string | null;
  status?: "active" | "closed" | null;
  notes?: string | null;
  overBudgetOverrideReason?: string | null;
}

export async function updateClassBudget(
  pool: PgLikePool,
  id: string,
  input: UpdateClassBudgetInput,
  actorId: string,
  reason?: string | null,
): Promise<ClassOperationResult<ClassBudgetRecord>> {
  if (!UUID.test(id)) return classFail("not_found", "That class budget no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      individual_id: string;
      label: string;
      authorized_amount: string;
      status: "active" | "closed";
      notes: string | null;
      program_id: string | null;
      budget_period_id: string | null;
      budget_authorization_id: string | null;
    }>(
      `SELECT individual_id, label, authorized_amount::text AS authorized_amount, status, notes,
              program_id, budget_period_id, budget_authorization_id
         FROM class_budget_periods
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    const before = rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class budget no longer exists.");
    }
    if (!before.program_id || !before.budget_period_id || !before.budget_authorization_id) {
      throw new Error("Class budget is missing its canonical program authorization link.");
    }
    let authorizedAmount = before.authorized_amount;
    if (input.authorizedAmount !== undefined && input.authorizedAmount !== null) {
      try {
        if (dec(input.authorizedAmount).lt(0)) {
          await client.query("ROLLBACK");
          return classFail("validation", "The class budget amount cannot be negative.");
        }
        authorizedAmount = toMoney(input.authorizedAmount);
      } catch {
        await client.query("ROLLBACK");
        return classFail("validation", "Enter a valid class budget amount.");
      }
    }
    const consumedResult = await client.query<{ consumed_amount: string }>(
      `SELECT COALESCE(sum(amount), 0)::text AS consumed_amount
         FROM class_budget_ledger
        WHERE class_budget_period_id = $1`,
      [id],
    );
    const consumed = dec(consumedResult.rows[0]?.consumed_amount ?? "0");
    if (dec(authorizedAmount).lt(consumed) && (input.overBudgetOverrideReason?.trim().length ?? 0) < 5) {
      await client.query("ROLLBACK");
      return classFail("conflict", "The new amount is below already issued class invoices. Add an override reason to continue.", {
        kind: "class_budget_overage",
        authorizedAmount,
        consumedAmount: toMoney(consumed),
        invoiceAmount: "0.0000",
        projectedAmount: toMoney(consumed),
        overageAmount: toMoney(consumed.minus(authorizedAmount)),
      });
    }
    const status = input.status ?? before.status;
    if (status !== "active" && status !== "closed") {
      await client.query("ROLLBACK");
      return classFail("validation", "Choose an active or closed class budget status.");
    }
    if (before.status !== "closed" && status === "closed") {
      const drafts = await client.query<{ draft_count: string }>(
        `SELECT count(*)::text AS draft_count
           FROM class_invoices
          WHERE class_budget_period_id = $1
            AND status = 'draft'`,
        [id],
      );
      if (Number(drafts.rows[0]?.draft_count ?? "0") > 0) {
        await client.query("ROLLBACK");
        return classFail("conflict", "Issue or update this allowance's draft invoices before closing it.");
      }
    }
    if (before.status === "closed" && status === "active") {
      await client.query(`SELECT id FROM individuals WHERE id = $1 FOR UPDATE`, [before.individual_id]);
      const overlap = await client.query(
        `SELECT 1 FROM class_budget_periods candidate
          JOIN class_budget_periods reopening ON reopening.id = $1
         WHERE candidate.individual_id = reopening.individual_id
           AND candidate.id <> reopening.id
           AND candidate.status = 'active'
           AND daterange(candidate.start_date, candidate.end_date, '[]')
               && daterange(reopening.start_date, reopening.end_date, '[]')
         LIMIT 1`,
        [id],
      );
      if (overlap.rows[0]) {
        await client.query("ROLLBACK");
        return classFail("conflict", "This budget overlaps another active class budget and cannot be reopened.");
      }
    }
    const next = {
      label: input.label === undefined ? before.label : input.label?.trim() || before.label,
      authorizedAmount,
      status,
      notes: input.notes === undefined ? before.notes : input.notes?.trim() || null,
    };
    await client.query(
      `UPDATE class_budget_periods
          SET label = $1, authorized_amount = $2, status = $3, notes = $4,
              updated_by_user_id = $5, updated_at = now()
        WHERE id = $6`,
      [next.label, next.authorizedAmount, next.status, next.notes, actorId, id],
    );
    if (before.budget_period_id) {
      await client.query(
        `UPDATE budget_periods
            SET label = $1, status = $2, notes = $3,
                archived_at = CASE WHEN $2 = 'closed' THEN COALESCE(archived_at, now()) ELSE NULL END,
                updated_at = now()
          WHERE id = $4`,
        [next.label, next.status, next.notes, before.budget_period_id],
      );
    }
    if (before.budget_authorization_id && !dec(next.authorizedAmount).eq(before.authorized_amount)) {
      const revised = await client.query<{ id: string }>(
        `WITH prior AS (
           UPDATE budget_authorizations
              SET status = 'superseded', updated_at = now()
            WHERE id = $1 AND status = 'active'
            RETURNING *
         )
         INSERT INTO budget_authorizations
           (budget_period_id, individual_id, program_id, authorized_hours,
            internal_rate, rate_override, source_row_ref, revision, supersedes_id,
            status, authorized_dollars, agency_rate, individual_rate_override,
            rate_basis, notes, source, created_by_user_id)
         SELECT budget_period_id, individual_id, program_id, authorized_hours,
                internal_rate, rate_override, source_row_ref, revision + 1, id,
                'active', $2, agency_rate, individual_rate_override,
                rate_basis, $3, source, $4
           FROM prior
         RETURNING id`,
        [before.budget_authorization_id, next.authorizedAmount, next.notes, actorId],
      );
      if (!revised.rows[0]) throw new Error("The linked class budget authorization is no longer active.");
      await client.query(
        `UPDATE class_budget_periods SET budget_authorization_id = $1 WHERE id = $2`,
        [revised.rows[0].id, id],
      );
    }
    await recordChange(client, {
      actorId,
      action: "class_budget_updated",
      entityType: "class_budget",
      entityId: id,
      previous: before,
      next,
      reason: reason ?? input.overBudgetOverrideReason ?? null,
    });
    await client.query("COMMIT");
    return ok((await getClassBudget(pool, id))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface ClassInvoiceDraftInput {
  classBudgetPeriodId: string;
  invoiceNumber: string;
  invoiceDate: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  billToName?: string | null;
  billToAddressLine1?: string | null;
  billToAddressLine2?: string | null;
  billToCityStateZip?: string | null;
  purpose?: string | null;
  notes?: string | null;
  lines?: ClassInvoiceLineInput[];
}

export type UpdateClassInvoiceDraftInput = Partial<Omit<ClassInvoiceDraftInput, "classBudgetPeriodId">>;

function validateInvoiceHeader(input: Omit<ClassInvoiceDraftInput, "lines">): string | null {
  if (!UUID.test(input.classBudgetPeriodId)) return "Choose a class budget.";
  if (!input.invoiceNumber?.trim()) return "Give the invoice a number.";
  if (input.billToName !== undefined && input.billToName !== null && !input.billToName.trim()) {
    return "Give the invoice a bill-to name.";
  }
  if (!isIsoCalendarDate(input.invoiceDate)) return "Give the invoice a valid date.";
  if (isSaturday(input.invoiceDate)) return "The invoice date cannot be a Saturday.";
  if (!isIsoCalendarDate(input.servicePeriodStart) || !isIsoCalendarDate(input.servicePeriodEnd)) {
    return "Give the invoice a valid service period.";
  }
  if (input.servicePeriodEnd < input.servicePeriodStart) {
    return "The invoice service period ends before it starts.";
  }
  return null;
}

async function activityPricing(
  db: Queryable,
  lines: readonly ClassInvoiceLineInput[],
): Promise<Map<string, ClassActivityPricing>> {
  const ids = [...new Set(lines.map((line) => line.activityId?.trim()).filter((id): id is string => Boolean(id && UUID.test(id))))];
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; name: string; default_unit_price: string }>(
    `SELECT id, name, default_unit_price::text AS default_unit_price
       FROM class_activities
      WHERE id = ANY($1::uuid[]) AND is_active`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, {
    id: row.id,
    name: row.name,
    defaultUnitPrice: toMoney(row.default_unit_price),
  }]));
}

async function insertPreparedLines(
  client: PgLikeClient,
  invoiceId: string,
  lines: Extract<ReturnType<typeof prepareClassInvoiceLines>, { ok: true }>,
): Promise<void> {
  for (const line of lines.lines) {
    await client.query(
      `INSERT INTO class_invoice_lines
         (class_invoice_id, class_activity_id, service_date, description, quantity,
          unit_price, discount_amount, line_total, sort_order, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [invoiceId, line.activityId, line.serviceDate, line.description, line.quantity,
       line.unitPrice, line.discountAmount, line.lineTotal, line.sortOrder, line.notes],
    );
  }
}

export async function createClassInvoiceDraft(
  pool: PgLikePool,
  input: ClassInvoiceDraftInput,
  actorId: string,
  reason?: string | null,
): Promise<ClassOperationResult<ClassInvoiceRecord>> {
  const validation = validateInvoiceHeader(input);
  if (validation) return classFail("validation", validation);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const budgetResult = await client.query<{
      individual_id: string;
      display_name: string;
      start_date: string;
      end_date: string;
      status: string;
    }>(
      `SELECT b.individual_id, i.display_name, b.start_date::text AS start_date,
              b.end_date::text AS end_date, b.status
         FROM class_budget_periods b
         JOIN individuals i ON i.id = b.individual_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [input.classBudgetPeriodId],
    );
    const budget = budgetResult.rows[0];
    if (!budget) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class budget no longer exists.");
    }
    if (budget.status !== "active") {
      await client.query("ROLLBACK");
      return classFail("conflict", "That class budget is closed.");
    }
    if (input.servicePeriodStart < budget.start_date || input.servicePeriodEnd > budget.end_date) {
      await client.query("ROLLBACK");
      return classFail("validation", "The invoice service period must be inside the class budget period.");
    }
    const linesInput = input.lines ?? [];
    const prices = await activityPricing(client, linesInput);
    const prepared = prepareClassInvoiceLines(linesInput, prices, input.servicePeriodStart, input.servicePeriodEnd);
    if (!prepared.ok) {
      await client.query("ROLLBACK");
      return classFail("validation", prepared.message);
    }
    const duplicate = await client.query(
      `SELECT 1 FROM class_invoices WHERE lower(invoice_number) = lower($1)`,
      [input.invoiceNumber.trim()],
    );
    if (duplicate.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("conflict", "That invoice number is already in use.");
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO class_invoices
         (class_budget_period_id, individual_id, invoice_number, invoice_date,
          service_period_start, service_period_end, bill_to_name,
          bill_to_address_line_1, bill_to_address_line_2, bill_to_city_state_zip,
          purpose, notes, subtotal, discount_total, total_amount,
          created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
       RETURNING id`,
      [
        input.classBudgetPeriodId,
        budget.individual_id,
        input.invoiceNumber.trim(),
        input.invoiceDate,
        input.servicePeriodStart,
        input.servicePeriodEnd,
        input.billToName?.trim() || budget.display_name,
        input.billToAddressLine1?.trim() || null,
        input.billToAddressLine2?.trim() || null,
        input.billToCityStateZip?.trim() || null,
        input.purpose?.trim() || "CLASSES",
        input.notes?.trim() || null,
        prepared.subtotal,
        prepared.discountTotal,
        prepared.totalAmount,
        actorId,
      ],
    );
    await insertPreparedLines(client, rows[0]!.id, prepared);
    await recordChange(client, {
      actorId,
      action: "class_invoice_draft_created",
      entityType: "class_invoice",
      entityId: rows[0]!.id,
      next: { invoiceNumber: input.invoiceNumber.trim(), lineCount: prepared.lines.length, totalAmount: prepared.totalAmount },
      reason,
    });
    await client.query("COMMIT");
    return ok((await getClassInvoice(pool, rows[0]!.id))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateClassInvoiceDraft(
  pool: PgLikePool,
  id: string,
  input: UpdateClassInvoiceDraftInput,
  actorId: string,
  reason?: string | null,
): Promise<ClassOperationResult<ClassInvoiceRecord>> {
  if (!UUID.test(id)) return classFail("not_found", "That class invoice no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      class_budget_period_id: string;
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
      status: string;
    }>(
      `SELECT class_budget_period_id, invoice_number, invoice_date::text AS invoice_date,
              service_period_start::text AS service_period_start,
              service_period_end::text AS service_period_end, bill_to_name,
              bill_to_address_line_1, bill_to_address_line_2, bill_to_city_state_zip,
              purpose, notes, status
         FROM class_invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const before = locked.rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class invoice no longer exists.");
    }
    if (before.status !== "draft") {
      await client.query("ROLLBACK");
      return classFail("immutable", "Issued and void invoices cannot be edited.");
    }
    const header: Omit<ClassInvoiceDraftInput, "lines"> = {
      classBudgetPeriodId: before.class_budget_period_id,
      invoiceNumber: input.invoiceNumber?.trim() || before.invoice_number,
      invoiceDate: input.invoiceDate ?? before.invoice_date,
      servicePeriodStart: input.servicePeriodStart ?? before.service_period_start,
      servicePeriodEnd: input.servicePeriodEnd ?? before.service_period_end,
      billToName: input.billToName === undefined ? before.bill_to_name : input.billToName,
      billToAddressLine1: input.billToAddressLine1 === undefined ? before.bill_to_address_line_1 : input.billToAddressLine1,
      billToAddressLine2: input.billToAddressLine2 === undefined ? before.bill_to_address_line_2 : input.billToAddressLine2,
      billToCityStateZip: input.billToCityStateZip === undefined ? before.bill_to_city_state_zip : input.billToCityStateZip,
      purpose: input.purpose === undefined ? before.purpose : input.purpose,
      notes: input.notes === undefined ? before.notes : input.notes,
    };
    const validation = validateInvoiceHeader(header);
    if (validation) {
      await client.query("ROLLBACK");
      return classFail("validation", validation);
    }
    const budget = await client.query<{ start_date: string; end_date: string }>(
      `SELECT start_date::text AS start_date, end_date::text AS end_date
         FROM class_budget_periods WHERE id = $1 FOR SHARE`,
      [before.class_budget_period_id],
    );
    if (header.servicePeriodStart < budget.rows[0]!.start_date || header.servicePeriodEnd > budget.rows[0]!.end_date) {
      await client.query("ROLLBACK");
      return classFail("validation", "The invoice service period must be inside the class budget period.");
    }
    let linesInput = input.lines;
    if (!linesInput) {
      const existing = await client.query<{
        class_activity_id: string | null;
        service_date: string;
        description: string;
        quantity: string;
        unit_price: string;
        discount_amount: string;
        sort_order: number;
        notes: string | null;
      }>(
        `SELECT class_activity_id, service_date::text AS service_date, description,
                quantity::text AS quantity, unit_price::text AS unit_price,
                discount_amount::text AS discount_amount, sort_order, notes
           FROM class_invoice_lines WHERE class_invoice_id = $1
          ORDER BY sort_order, service_date, id`,
        [id],
      );
      linesInput = existing.rows.map((line) => ({
        activityId: line.class_activity_id,
        serviceDate: line.service_date,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        discountAmount: line.discount_amount,
        sortOrder: line.sort_order,
        notes: line.notes,
      }));
    }
    const prices = await activityPricing(client, linesInput);
    // Existing lines retain their snapshot description and price even when an
    // administrator has since archived the activity.
    const prepared = prepareClassInvoiceLines(
      linesInput.map((line) => line.activityId && !prices.has(line.activityId)
        ? { ...line, activityId: null }
        : line),
      prices,
      header.servicePeriodStart,
      header.servicePeriodEnd,
    );
    if (!prepared.ok) {
      await client.query("ROLLBACK");
      return classFail("validation", prepared.message);
    }
    const duplicate = await client.query(
      `SELECT 1 FROM class_invoices WHERE lower(invoice_number) = lower($1) AND id <> $2`,
      [header.invoiceNumber.trim(), id],
    );
    if (duplicate.rows[0]) {
      await client.query("ROLLBACK");
      return classFail("conflict", "That invoice number is already in use.");
    }
    await client.query(
      `UPDATE class_invoices
          SET invoice_number = $1, invoice_date = $2, service_period_start = $3,
              service_period_end = $4, bill_to_name = $5, bill_to_address_line_1 = $6,
              bill_to_address_line_2 = $7, bill_to_city_state_zip = $8, purpose = $9,
              notes = $10, subtotal = $11, discount_total = $12, total_amount = $13,
              updated_by_user_id = $14, updated_at = now()
        WHERE id = $15`,
      [header.invoiceNumber.trim(), header.invoiceDate, header.servicePeriodStart,
       header.servicePeriodEnd, header.billToName?.trim() || "", header.billToAddressLine1?.trim() || null,
       header.billToAddressLine2?.trim() || null, header.billToCityStateZip?.trim() || null,
       header.purpose?.trim() || "CLASSES", header.notes?.trim() || null,
       prepared.subtotal, prepared.discountTotal, prepared.totalAmount, actorId, id],
    );
    await client.query(`DELETE FROM class_invoice_lines WHERE class_invoice_id = $1`, [id]);
    await insertPreparedLines(client, id, prepared);
    await recordChange(client, {
      actorId,
      action: "class_invoice_draft_updated",
      entityType: "class_invoice",
      entityId: id,
      previous: before,
      next: { invoiceNumber: header.invoiceNumber.trim(), lineCount: prepared.lines.length, totalAmount: prepared.totalAmount },
      reason,
    });
    await client.query("COMMIT");
    return ok((await getClassInvoice(pool, id))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function discardClassInvoiceDraft(
  pool: PgLikePool,
  id: string,
  actorId: string,
  reason?: string | null,
): Promise<ClassOperationResult<{ id: string }>> {
  if (!UUID.test(id)) return classFail("not_found", "That class invoice no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      invoice_number: string;
      status: string;
      total_amount: string;
    }>(
      `SELECT invoice_number, status, total_amount::text AS total_amount
         FROM class_invoices
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    const invoice = locked.rows[0];
    if (!invoice) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class invoice no longer exists.");
    }
    if (invoice.status !== "draft") {
      await client.query("ROLLBACK");
      return classFail("immutable", "Only a draft class invoice can be discarded.");
    }
    const lineCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM class_invoice_lines WHERE class_invoice_id = $1`,
      [id],
    );
    await client.query(`DELETE FROM class_invoice_lines WHERE class_invoice_id = $1`, [id]);
    await client.query(`DELETE FROM class_invoices WHERE id = $1`, [id]);
    await recordChange(client, {
      actorId,
      action: "class_invoice_draft_discarded",
      entityType: "class_invoice",
      entityId: id,
      previous: {
        invoiceNumber: invoice.invoice_number,
        totalAmount: toMoney(invoice.total_amount),
        lineCount: Number(lineCount.rows[0]?.count ?? 0),
      },
      reason,
    });
    await client.query("COMMIT");
    return ok({ id });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function issueClassInvoice(
  pool: PgLikePool,
  id: string,
  actorId: string,
  input: { overBudgetOverrideReason?: string | null; reason?: string | null } = {},
): Promise<ClassOperationResult<ClassInvoiceRecord>> {
  if (!UUID.test(id)) return classFail("not_found", "That class invoice no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoiceResult = await client.query<{
      class_budget_period_id: string;
      status: string;
      total_amount: string;
      service_period_end: string;
    }>(
      `SELECT class_budget_period_id, status, total_amount::text AS total_amount,
              service_period_end::text AS service_period_end
         FROM class_invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class invoice no longer exists.");
    }
    if (invoice.status !== "draft") {
      await client.query("ROLLBACK");
      return classFail("immutable", "Only a draft class invoice can be issued.");
    }
    const totalsResult = await client.query<{
      line_count: string;
      subtotal: string;
      discount_total: string;
      total_amount: string;
    }>(
      `SELECT count(*)::text AS line_count,
              COALESCE(sum(line_total + discount_amount), 0)::text AS subtotal,
              COALESCE(sum(discount_amount), 0)::text AS discount_total,
              COALESCE(sum(line_total), 0)::text AS total_amount
         FROM class_invoice_lines WHERE class_invoice_id = $1`,
      [id],
    );
    const totals = totalsResult.rows[0]!;
    if (Number(totals.line_count) < 1 || dec(totals.total_amount).lte(0)) {
      await client.query("ROLLBACK");
      return classFail("validation", "Add at least one billable class line before issuing the invoice.");
    }
    const budgetResult = await client.query<{
      authorized_amount: string;
      status: string;
    }>(
      `SELECT authorized_amount::text AS authorized_amount, status
         FROM class_budget_periods
        WHERE id = $1
        FOR UPDATE`,
      [invoice.class_budget_period_id],
    );
    const budget = budgetResult.rows[0];
    if (!budget || budget.status !== "active") {
      await client.query("ROLLBACK");
      return classFail("conflict", "The class budget is closed or no longer available.");
    }
    const consumedResult = await client.query<{ consumed_amount: string }>(
      `SELECT COALESCE(sum(amount), 0)::text AS consumed_amount
         FROM class_budget_ledger
        WHERE class_budget_period_id = $1`,
      [invoice.class_budget_period_id],
    );
    const authorized = dec(budget.authorized_amount);
    const consumed = dec(consumedResult.rows[0]?.consumed_amount ?? "0");
    const invoiceAmount = dec(totals.total_amount);
    const projected = consumed.plus(invoiceAmount);
    const overage = maxZero(projected.minus(authorized));
    const details: ClassBudgetOverageDetails = {
      kind: "class_budget_overage",
      authorizedAmount: toMoney(authorized),
      consumedAmount: toMoney(consumed),
      invoiceAmount: toMoney(invoiceAmount),
      projectedAmount: toMoney(projected),
      overageAmount: toMoney(overage),
    };
    const overrideReason = input.overBudgetOverrideReason?.trim() || null;
    if (overage.gt(0) && (overrideReason?.length ?? 0) < 5) {
      await client.query("ROLLBACK");
      return classFail(
        "conflict",
        "This invoice exceeds the individual's annual class budget. Review the warning and add an override reason to issue it.",
        details,
      );
    }
    await client.query(
      `UPDATE class_invoices
          SET status = 'issued', subtotal = $1, discount_total = $2, total_amount = $3,
              budget_authorized_snapshot = $4, budget_consumed_before_snapshot = $5,
              budget_overage_snapshot = $6, over_budget_override_reason = $7,
              issued_by_user_id = $8, issued_at = now(),
              updated_by_user_id = $8, updated_at = now()
        WHERE id = $9`,
      [toMoney(totals.subtotal), toMoney(totals.discount_total), toMoney(totals.total_amount),
       details.authorizedAmount, details.consumedAmount, details.overageAmount,
       overage.gt(0) ? overrideReason : null, actorId, id],
    );
    await client.query(
      `INSERT INTO class_budget_ledger
         (class_budget_period_id, class_invoice_id, event_type, amount, created_by_user_id)
       VALUES ($1, $2, 'issue', $3, $4)`,
      [invoice.class_budget_period_id, id, details.invoiceAmount, actorId],
    );
    await postClassProgramBudgetIssue(
      client,
      invoice.class_budget_period_id,
      id,
      invoice.service_period_end,
      details.invoiceAmount,
      actorId,
    );
    await recordChange(client, {
      actorId,
      action: "class_invoice_issued",
      entityType: "class_invoice",
      entityId: id,
      previous: { status: "draft" },
      next: { status: "issued", ...details },
      reason: input.reason ?? overrideReason,
    });
    await client.query("COMMIT");
    return ok((await getClassInvoice(pool, id))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function maxZero(value: ReturnType<typeof dec>): ReturnType<typeof dec> {
  return value.lt(0) ? dec(0) : value;
}

export async function voidClassInvoice(
  pool: PgLikePool,
  id: string,
  actorId: string,
  reason: string,
): Promise<ClassOperationResult<ClassInvoiceRecord>> {
  if (!UUID.test(id)) return classFail("not_found", "That class invoice no longer exists.");
  const voidReason = reason?.trim() || "";
  if (voidReason.length < 5) return classFail("validation", "Give a reason for voiding the invoice.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      class_budget_period_id: string;
      status: string;
      total_amount: string;
    }>(
      `SELECT class_budget_period_id, status, total_amount::text AS total_amount
         FROM class_invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const invoice = rows[0];
    if (!invoice) {
      await client.query("ROLLBACK");
      return classFail("not_found", "That class invoice no longer exists.");
    }
    if (invoice.status !== "issued") {
      await client.query("ROLLBACK");
      return classFail("immutable", "Only an issued class invoice can be voided.");
    }
    await client.query(
      `SELECT id FROM class_budget_periods WHERE id = $1 FOR UPDATE`,
      [invoice.class_budget_period_id],
    );
    await client.query(
      `UPDATE class_invoices
          SET status = 'void', voided_by_user_id = $1, voided_at = now(),
              void_reason = $2, updated_by_user_id = $1, updated_at = now()
        WHERE id = $3`,
      [actorId, voidReason, id],
    );
    await client.query(
      `INSERT INTO class_budget_ledger
         (class_budget_period_id, class_invoice_id, event_type, amount, created_by_user_id)
       VALUES ($1, $2, 'void', $3, $4)`,
      [invoice.class_budget_period_id, id, toMoney(dec(invoice.total_amount).negated()), actorId],
    );
    await postClassProgramBudgetReversal(client, id, actorId, voidReason);
    await recordChange(client, {
      actorId,
      action: "class_invoice_voided",
      entityType: "class_invoice",
      entityId: id,
      previous: { status: "issued", totalAmount: toMoney(invoice.total_amount) },
      next: { status: "void", releasedAmount: toMoney(invoice.total_amount) },
      reason: voidReason,
    });
    await client.query("COMMIT");
    return ok((await getClassInvoice(pool, id))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

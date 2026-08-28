import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec } from "@/lib/money";
import { recordChange } from "@/lib/manage/audit";
import { fail, ok, type Result } from "@/lib/manage/errors";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";
import { agencyDate } from "@/lib/business/agency-time";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DirectDealRule = "keep_all" | "giveback_percent" | "giveback_all";

export interface EmployeeDeal {
  id: string;
  employeeId: string;
  employeeName: string;
  directRule: DirectDealRule;
  directPercent: string;
  agencyCutPercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  revision: number;
  status: "active" | "archived";
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DealRow {
  id: string;
  employee_id: string;
  employee_name: string;
  direct_rule: DirectDealRule;
  direct_percent: string;
  agency_cut_percent: string;
  effective_from: string;
  effective_to: string | null;
  revision: number;
  status: "active" | "archived";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveEmployeeDealInput {
  employeeId: string;
  directRule: DirectDealRule;
  /** Fractions: 0.10 means 10%. */
  directPercent?: string | null;
  agencyCutPercent?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
  reason: string;
}

function mapDeal(row: DealRow): EmployeeDeal {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    directRule: row.direct_rule,
    directPercent: row.direct_percent,
    agencyCutPercent: row.agency_cut_percent,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    revision: row.revision,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function previousDay(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function fraction(value: string | null | undefined, label: string): Result<string> {
  try {
    const parsed = dec(value ?? "0");
    if (parsed.isNegative() || parsed.greaterThan(1)) {
      return fail("validation", `${label} must be between 0% and 100%.`);
    }
    return ok(parsed.toDecimalPlaces(6).toFixed(6));
  } catch {
    return fail("validation", `${label} must be a valid percentage.`);
  }
}

async function inTransaction<T>(pool: PgLikePool, run: (client: PgLikeClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireSettlementSourceLock(client);
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

export async function listEmployeeDeals(pool: PgLikePool, employeeId: string): Promise<EmployeeDeal[]> {
  if (!UUID.test(employeeId)) return [];
  const { rows } = await pool.query<DealRow>(
    `SELECT d.id, d.employee_id,
            COALESCE(e.display_name, e.normalized_name) AS employee_name,
            d.direct_rule, d.direct_percent::text, d.agency_cut_percent::text,
            to_char(d.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(d.effective_to, 'YYYY-MM-DD') AS effective_to,
            d.revision, d.status, d.notes,
            d.created_at::text, d.updated_at::text
       FROM employee_deals d
       JOIN employees e ON e.id = d.employee_id
      WHERE d.employee_id = $1
      ORDER BY d.effective_from DESC, d.created_at DESC`,
    [employeeId],
  );
  return rows.map(mapDeal);
}

export async function getEmployeeDealAsOf(
  pool: PgLikePool,
  employeeId: string,
  asOf = agencyDate(),
): Promise<EmployeeDeal | null> {
  if (!UUID.test(employeeId) || !validDate(asOf)) return null;
  const { rows } = await pool.query<DealRow>(
    `SELECT d.id, d.employee_id,
            COALESCE(e.display_name, e.normalized_name) AS employee_name,
            d.direct_rule, d.direct_percent::text, d.agency_cut_percent::text,
            to_char(d.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(d.effective_to, 'YYYY-MM-DD') AS effective_to,
            d.revision, d.status, d.notes,
            d.created_at::text, d.updated_at::text
       FROM employee_deals d
       JOIN employees e ON e.id = d.employee_id
      WHERE d.employee_id = $1 AND d.status = 'active'
        AND d.effective_from <= $2::date
        AND (d.effective_to IS NULL OR d.effective_to >= $2::date)
      ORDER BY d.effective_from DESC
      LIMIT 1`,
    [employeeId, asOf],
  );
  return rows[0] ? mapDeal(rows[0]) : null;
}

async function snapshotDeal(
  client: PgLikeClient,
  row: DealRow,
  actorId: string | null,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO employee_deal_revisions
       (employee_deal_id, revision, snapshot, reason, created_by_user_id)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [row.id, row.revision, JSON.stringify(mapDeal(row)), reason, actorId],
  );
}

export async function saveEmployeeDeal(
  pool: PgLikePool,
  input: SaveEmployeeDealInput,
  actorId: string | null,
): Promise<Result<EmployeeDeal>> {
  if (!UUID.test(input.employeeId)) return fail("validation", "Choose an employee.");
  if (!(["keep_all", "giveback_percent", "giveback_all"] as const).includes(input.directRule)) {
    return fail("validation", "Choose a valid direct-pay rule.");
  }
  const requestedEnd = input.effectiveTo?.trim() || null;
  if (!validDate(input.effectiveFrom) || (requestedEnd && !validDate(requestedEnd))) {
    return fail("validation", "Enter valid effective dates.");
  }
  if (requestedEnd && requestedEnd < input.effectiveFrom) {
    return fail("validation", "The ending date cannot be before the starting date.");
  }
  const reason = input.reason.trim();
  if (!reason) return fail("validation", "Enter a reason for this deal change.");

  const direct = fraction(input.directPercent, "Direct give-back");
  if (!direct.ok) return direct;
  const agency = fraction(input.agencyCutPercent, "Agency cut");
  if (!agency.ok) return agency;
  const directPercent = input.directRule === "giveback_percent" ? direct.data : "0.000000";

  return inTransaction(pool, async (client) => {
    const employee = await client.query<{ id: string }>(
      `SELECT id FROM employees WHERE id = $1 AND status <> 'archived' FOR UPDATE`,
      [input.employeeId],
    );
    if (!employee.rows[0]) return fail("not_found", "That employee no longer exists.");

    const deals = await client.query<DealRow>(
      `SELECT d.id, d.employee_id,
              COALESCE(e.display_name, e.normalized_name) AS employee_name,
              d.direct_rule, d.direct_percent::text, d.agency_cut_percent::text,
              to_char(d.effective_from, 'YYYY-MM-DD') AS effective_from,
              to_char(d.effective_to, 'YYYY-MM-DD') AS effective_to,
              d.revision, d.status, d.notes,
              d.created_at::text, d.updated_at::text
         FROM employee_deals d
         JOIN employees e ON e.id = d.employee_id
        WHERE d.employee_id = $1 AND d.status = 'active'
        ORDER BY d.effective_from
        FOR UPDATE OF d`,
      [input.employeeId],
    );

    const same = deals.rows.find((deal) => deal.effective_from === input.effectiveFrom);
    const successor = deals.rows.find((deal) => deal.effective_from > input.effectiveFrom);
    const effectiveTo = requestedEnd ?? (successor ? previousDay(successor.effective_from) : null);
    if (successor && effectiveTo && effectiveTo >= successor.effective_from) {
      return fail("conflict", `This deal overlaps the deal beginning ${successor.effective_from}.`);
    }

    if (same) {
      if (successor && effectiveTo && effectiveTo >= successor.effective_from) {
        return fail("conflict", `This deal overlaps the deal beginning ${successor.effective_from}.`);
      }
      await snapshotDeal(client, same, actorId, reason);
      const updated = await client.query<DealRow>(
        `UPDATE employee_deals
            SET direct_rule = $2, direct_percent = $3, agency_cut_percent = $4,
                effective_to = $5, notes = $6, revision = revision + 1,
                updated_by_user_id = $7, updated_at = now()
          WHERE id = $1
        RETURNING id, employee_id,
                  (SELECT COALESCE(e.display_name, e.normalized_name) FROM employees e WHERE e.id = employee_deals.employee_id) AS employee_name,
                  direct_rule, direct_percent::text, agency_cut_percent::text,
                  to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                  to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
                  revision, status, notes, created_at::text, updated_at::text`,
        [same.id, input.directRule, directPercent, agency.data, effectiveTo, input.notes?.trim() || null, actorId],
      );
      const saved = mapDeal(updated.rows[0]);
      await recordChange(client, {
        actorId,
        action: "employee_deal.updated",
        entityType: "employee_deal",
        entityId: same.id,
        previous: mapDeal(same),
        next: saved,
        reason,
      });
      return ok(saved);
    }

    const predecessor = [...deals.rows]
      .reverse()
      .find((deal) => deal.effective_from < input.effectiveFrom && (!deal.effective_to || deal.effective_to >= input.effectiveFrom));
    if (predecessor) {
      await snapshotDeal(client, predecessor, actorId, reason);
      await client.query(
        `UPDATE employee_deals
            SET effective_to = $2::date, revision = revision + 1,
                updated_by_user_id = $3, updated_at = now()
          WHERE id = $1`,
        [predecessor.id, previousDay(input.effectiveFrom), actorId],
      );
    }

    const inserted = await client.query<DealRow>(
      `INSERT INTO employee_deals
         (employee_id, direct_rule, direct_percent, agency_cut_percent,
          effective_from, effective_to, notes, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $8)
       RETURNING id, employee_id,
                 (SELECT COALESCE(e.display_name, e.normalized_name) FROM employees e WHERE e.id = employee_deals.employee_id) AS employee_name,
                 direct_rule, direct_percent::text, agency_cut_percent::text,
                 to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                 to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
                 revision, status, notes, created_at::text, updated_at::text`,
      [
        input.employeeId,
        input.directRule,
        directPercent,
        agency.data,
        input.effectiveFrom,
        effectiveTo,
        input.notes?.trim() || null,
        actorId,
      ],
    );
    const saved = mapDeal(inserted.rows[0]);
    await recordChange(client, {
      actorId,
      action: "employee_deal.created",
      entityType: "employee_deal",
      entityId: saved.id,
      next: saved,
      reason,
    });
    return ok(saved);
  });
}

export function percentToFraction(value: unknown): string {
  const raw = String(value ?? "").trim().replace("%", "");
  if (!raw) return "0";
  try {
    return dec(raw).dividedBy(100).toDecimalPlaces(6).toFixed(6);
  } catch {
    return raw;
  }
}

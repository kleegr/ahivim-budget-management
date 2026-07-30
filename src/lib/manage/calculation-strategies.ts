import type { PgLikePool, PgLikeClient } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange } from "@/lib/manage/audit";
import { dec, toMoney, toHours } from "@/lib/money";
import {
  computeStrategy,
  derivePeriodFromRenewal,
  type StrategyResult,
} from "@/lib/business/calculation-strategy";

/**
 * Services for calculation strategies — the editable "Calculations" workspace.
 *
 * A canonical individual has one or more strategies; each strategy owns its own
 * program hours, cuts, adjustments, renewal date, account and "After All".
 * Internal rates are read from the effective-dated program_rate_schedules
 * (never hardcoded). Every edit first snapshots the prior state into
 * calculation_strategy_revisions, so changes are non-destructive.
 */

export interface ProgramRate {
  id: string;
  code: string;
  name: string;
  internalRate: string; // effective internal rate as of the strategy's renewal date
}

export interface StrategyGridRow {
  id: string;
  individualId: string;
  individualName: string;
  label: string;
  renewalDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  monthDivisor: string;
  cut1Percent: string; // fraction (0.24)
  cut2Percent: string;
  clockAdjustment: string;
  otherAdjustment: string;
  afterAll: string | null;
  account: string | null;
  status: string;
  sortOrder: number;
  hours: Record<string, string>; // programId -> hours
  yearlyGross: string;
  monthlyGross: string;
  grossNet: string;
  net: string;
  revisionCount: number;
}

interface RateScheduleRow {
  program_id: string;
  internal_rate: string;
  effective_from: string;
}

/** Pick each program's internal rate effective on or before `asOf` (or the earliest if none). */
function rateAsOf(schedules: RateScheduleRow[], programId: string, asOf: string | null): string {
  const forProgram = schedules
    .filter((s) => s.program_id === programId)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  if (forProgram.length === 0) return "0";
  const cutoff = asOf ?? "9999-12-31";
  let chosen = forProgram[0]!;
  for (const s of forProgram) {
    if (s.effective_from <= cutoff) chosen = s;
    else break;
  }
  return chosen.internal_rate;
}

export async function listProgramRates(pool: PgLikePool, asOf?: string | null): Promise<ProgramRate[]> {
  const { rows } = await pool.query<{ id: string; code: string; name: string; internal_rate: string | null }>(
    `SELECT p.id, p.code, p.name,
            (SELECT prs.internal_rate::text FROM program_rate_schedules prs
              WHERE prs.program_id = p.id
                AND prs.effective_from <= COALESCE($1::date, CURRENT_DATE)
              ORDER BY prs.effective_from DESC LIMIT 1) AS internal_rate
       FROM programs p
      WHERE p.is_active IS DISTINCT FROM false
      ORDER BY p.code`,
    [asOf ?? null],
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, internalRate: r.internal_rate ?? "0" }));
}

export async function listStrategies(
  pool: PgLikePool,
  opts: { individualId?: string; includeArchived?: boolean } = {},
): Promise<{ rows: StrategyGridRow[]; programs: ProgramRate[] }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.individualId) {
    params.push(opts.individualId);
    where.push(`s.individual_id = $${params.length}`);
  }
  if (!opts.includeArchived) where.push(`s.status = 'active'`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { rows: strategies } = await pool.query<{
    id: string;
    individual_id: string;
    individual_name: string;
    label: string;
    renewal_date: string | null;
    month_divisor: string;
    cut1_percent: string;
    cut2_percent: string;
    clock_adjustment: string;
    other_adjustment: string;
    after_all: string | null;
    account: string | null;
    status: string;
    sort_order: number;
    revision_count: string;
  }>(
    `SELECT s.id, s.individual_id,
            COALESCE(i.display_name, i.normalized_name) AS individual_name,
            s.label,
            to_char(s.renewal_date, 'YYYY-MM-DD') AS renewal_date,
            s.month_divisor::text, s.cut1_percent::text, s.cut2_percent::text,
            s.clock_adjustment::text, s.other_adjustment::text,
            s.after_all::text, s.account, s.status, s.sort_order,
            (SELECT count(*)::text FROM calculation_strategy_revisions r WHERE r.strategy_id = s.id) AS revision_count
       FROM calculation_strategies s
       JOIN individuals i ON i.id = s.individual_id
       ${whereSql}
      ORDER BY individual_name, s.sort_order, s.label`,
    params,
  );

  const ids = strategies.map((s) => s.id);
  const lines = ids.length
    ? (
        await pool.query<{ strategy_id: string; program_id: string; authorized_hours: string }>(
          `SELECT strategy_id, program_id, authorized_hours::text
             FROM calculation_strategy_lines WHERE strategy_id = ANY($1::uuid[])`,
          [ids],
        )
      ).rows
    : [];

  const { rows: schedules } = await pool.query<RateScheduleRow>(
    `SELECT program_id, internal_rate::text, to_char(effective_from,'YYYY-MM-DD') AS effective_from
       FROM program_rate_schedules`,
  );
  const programs = await listProgramRates(pool);

  const hoursByStrategy = new Map<string, Record<string, string>>();
  for (const l of lines) {
    const m = hoursByStrategy.get(l.strategy_id) ?? {};
    m[l.program_id] = l.authorized_hours;
    hoursByStrategy.set(l.strategy_id, m);
  }

  const rows: StrategyGridRow[] = strategies.map((s) => {
    const hours = hoursByStrategy.get(s.id) ?? {};
    const period = derivePeriodFromRenewal(s.renewal_date);
    const strategyLines = Object.entries(hours).map(([programId, h]) => ({
      programLabel: programId,
      hours: h,
      internalRate: rateAsOf(schedules, programId, s.renewal_date),
    }));
    const computed = computeStrategy({
      lines: strategyLines,
      monthDivisor: s.month_divisor,
      cut1Percent: s.cut1_percent,
      cut2Percent: s.cut2_percent,
      clockAdjustment: s.clock_adjustment,
      otherAdjustment: s.other_adjustment,
      afterAll: s.after_all,
    });
    return {
      id: s.id,
      individualId: s.individual_id,
      individualName: s.individual_name,
      label: s.label,
      renewalDate: s.renewal_date,
      periodStart: period.start,
      periodEnd: period.end,
      monthDivisor: s.month_divisor,
      cut1Percent: s.cut1_percent,
      cut2Percent: s.cut2_percent,
      clockAdjustment: s.clock_adjustment,
      otherAdjustment: s.other_adjustment,
      afterAll: s.after_all,
      account: s.account,
      status: s.status,
      sortOrder: s.sort_order,
      hours,
      yearlyGross: computed.yearlyGross,
      monthlyGross: computed.monthlyGross,
      grossNet: computed.grossNet,
      net: computed.net,
      revisionCount: Number(s.revision_count),
    };
  });

  return { rows, programs };
}

/** Full step-by-step calculation for one strategy — powers the formula panel. */
export async function explainStrategy(pool: PgLikePool, id: string): Promise<StrategyResult | null> {
  const { rows } = await pool.query<{
    renewal_date: string | null;
    month_divisor: string;
    cut1_percent: string;
    cut2_percent: string;
    clock_adjustment: string;
    other_adjustment: string;
    after_all: string | null;
  }>(
    `SELECT to_char(renewal_date,'YYYY-MM-DD') AS renewal_date, month_divisor::text,
            cut1_percent::text, cut2_percent::text, clock_adjustment::text,
            other_adjustment::text, after_all::text
       FROM calculation_strategies WHERE id = $1`,
    [id],
  );
  const s = rows[0];
  if (!s) return null;
  const { rows: lines } = await pool.query<{ program_id: string; program_label: string; authorized_hours: string }>(
    `SELECT csl.program_id, COALESCE(p.name, p.code) AS program_label, csl.authorized_hours::text
       FROM calculation_strategy_lines csl JOIN programs p ON p.id = csl.program_id
      WHERE csl.strategy_id = $1`,
    [id],
  );
  const { rows: schedules } = await pool.query<RateScheduleRow>(
    `SELECT program_id, internal_rate::text, to_char(effective_from,'YYYY-MM-DD') AS effective_from
       FROM program_rate_schedules`,
  );
  return computeStrategy({
    lines: lines.map((l) => ({
      programLabel: l.program_label,
      hours: l.authorized_hours,
      internalRate: rateAsOf(schedules, l.program_id, s.renewal_date),
    })),
    monthDivisor: s.month_divisor,
    cut1Percent: s.cut1_percent,
    cut2Percent: s.cut2_percent,
    clockAdjustment: s.clock_adjustment,
    otherAdjustment: s.other_adjustment,
    afterAll: s.after_all,
  });
}

async function snapshot(client: PgLikeClient, strategyId: string, reason: string | null, actorId: string | null): Promise<void> {
  const { rows } = await client.query<{ snap: unknown; revision: number }>(
    `SELECT to_jsonb(s.*)
              || jsonb_build_object('lines',
                   COALESCE((SELECT jsonb_agg(to_jsonb(l.*)) FROM calculation_strategy_lines l WHERE l.strategy_id = s.id), '[]'::jsonb)
                 ) AS snap,
            (SELECT COALESCE(max(revision),0)+1 FROM calculation_strategy_revisions r WHERE r.strategy_id = s.id) AS revision
       FROM calculation_strategies s WHERE s.id = $1`,
    [strategyId],
  );
  if (!rows[0]) return;
  await client.query(
    `INSERT INTO calculation_strategy_revisions (strategy_id, revision, snapshot, reason, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [strategyId, rows[0].revision, JSON.stringify(rows[0].snap), reason, actorId],
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toFractionStr(value: unknown): string {
  if (value === null || value === undefined || value === "") return "0";
  const raw = typeof value === "string" ? value.replace("%", "") : value;
  const d = dec(raw as string | number);
  return (d.abs().greaterThan(1) ? d.dividedBy(100) : d).toString();
}

export async function createStrategy(
  pool: PgLikePool,
  input: { individualId: string; label?: string },
  actorId: string | null,
): Promise<Result<{ id: string }>> {
  if (!UUID.test(input.individualId)) return fail("validation", "A valid individual is required.");
  const label = (input.label ?? "").trim();
  // Default label: next number for this individual.
  let finalLabel = label;
  if (!finalLabel) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM calculation_strategies WHERE individual_id = $1`,
      [input.individualId],
    );
    finalLabel = String(Number(rows[0]?.n ?? 0) + 1);
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO calculation_strategies (individual_id, label, created_by_user_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [input.individualId, finalLabel, actorId],
  );
  const id = rows[0]!.id;
  await recordChange(pool, { actorId, action: "strategy_created", entityType: "calculation_strategy", entityId: id, extra: { label: finalLabel } });
  return ok({ id });
}

export interface UpdateStrategyInput {
  id: string;
  label?: string;
  renewalDate?: string | null;
  monthDivisor?: string | number | null;
  cut1Percent?: string | number | null;
  cut2Percent?: string | number | null;
  clockAdjustment?: string | number | null;
  otherAdjustment?: string | number | null;
  afterAll?: string | number | null;
  account?: string | null;
  hours?: Record<string, string | number | null>; // programId -> hours (upsert; null clears)
}

export async function updateStrategy(
  pool: PgLikePool,
  input: UpdateStrategyInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!UUID.test(input.id)) return fail("validation", "A valid strategy is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT id FROM calculation_strategies WHERE id = $1 FOR UPDATE`, [input.id]);
    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail("not_found", "That strategy no longer exists.");
    }
    await snapshot(client, input.id, reason ?? null, actorId);

    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (input.label !== undefined) set("label", String(input.label).trim() || "1");
    if (input.renewalDate !== undefined) set("renewal_date", input.renewalDate || null);
    if (input.monthDivisor !== undefined) set("month_divisor", input.monthDivisor == null || input.monthDivisor === "" ? 12 : dec(input.monthDivisor).toString());
    if (input.cut1Percent !== undefined) set("cut1_percent", toFractionStr(input.cut1Percent));
    if (input.cut2Percent !== undefined) set("cut2_percent", toFractionStr(input.cut2Percent));
    if (input.clockAdjustment !== undefined) set("clock_adjustment", input.clockAdjustment == null || input.clockAdjustment === "" ? "0" : toMoney(input.clockAdjustment as string));
    if (input.otherAdjustment !== undefined) set("other_adjustment", input.otherAdjustment == null || input.otherAdjustment === "" ? "0" : toMoney(input.otherAdjustment as string));
    if (input.afterAll !== undefined) set("after_all", input.afterAll == null || input.afterAll === "" ? null : toMoney(input.afterAll as string));
    if (input.account !== undefined) set("account", input.account || null);

    if (sets.length > 0) {
      vals.push(input.id);
      await client.query(`UPDATE calculation_strategies SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
    }

    if (input.hours) {
      for (const [programId, h] of Object.entries(input.hours)) {
        if (!UUID.test(programId)) continue;
        if (h === null || h === "") {
          await client.query(`DELETE FROM calculation_strategy_lines WHERE strategy_id = $1 AND program_id = $2`, [input.id, programId]);
        } else {
          await client.query(
            `INSERT INTO calculation_strategy_lines (strategy_id, program_id, authorized_hours)
             VALUES ($1,$2,$3)
             ON CONFLICT (strategy_id, program_id) DO UPDATE SET authorized_hours = EXCLUDED.authorized_hours, updated_at = now()`,
            [input.id, programId, toHours(h as string)],
          );
        }
      }
    }

    await recordChange(client, { actorId, action: "strategy_updated", entityType: "calculation_strategy", entityId: input.id, reason: reason ?? null });
    await client.query("COMMIT");
    return ok({ id: input.id });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail("validation", error instanceof Error ? error.message : "Could not save the change.");
  } finally {
    client.release();
  }
}

export async function duplicateStrategy(
  pool: PgLikePool,
  input: { id: string; label?: string },
  actorId: string | null,
): Promise<Result<{ id: string }>> {
  if (!UUID.test(input.id)) return fail("validation", "A valid strategy is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const src = await client.query<{ individual_id: string; label: string }>(
      `SELECT individual_id, label FROM calculation_strategies WHERE id = $1`,
      [input.id],
    );
    if (src.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail("not_found", "That strategy no longer exists.");
    }
    const label = (input.label ?? `${src.rows[0]!.label} copy`).trim();
    const created = await client.query<{ id: string }>(
      `INSERT INTO calculation_strategies
         (individual_id, label, renewal_date, month_divisor, cut1_percent, cut2_percent,
          clock_adjustment, other_adjustment, after_all, account, sort_order, notes, created_by_user_id)
       SELECT individual_id, $2, renewal_date, month_divisor, cut1_percent, cut2_percent,
          clock_adjustment, other_adjustment, after_all, account, sort_order + 1, notes, $3
         FROM calculation_strategies WHERE id = $1
       RETURNING id`,
      [input.id, label, actorId],
    );
    const newId = created.rows[0]!.id;
    await client.query(
      `INSERT INTO calculation_strategy_lines (strategy_id, program_id, authorized_hours)
       SELECT $2, program_id, authorized_hours FROM calculation_strategy_lines WHERE strategy_id = $1`,
      [input.id, newId],
    );
    await recordChange(client, { actorId, action: "strategy_duplicated", entityType: "calculation_strategy", entityId: newId, extra: { from: input.id } });
    await client.query("COMMIT");
    return ok({ id: newId });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail("validation", error instanceof Error ? error.message : "Could not duplicate the strategy.");
  } finally {
    client.release();
  }
}

export async function setStrategyStatus(
  pool: PgLikePool,
  input: { id: string; status: "active" | "archived" },
  actorId: string | null,
): Promise<Result<{ id: string }>> {
  if (!UUID.test(input.id)) return fail("validation", "A valid strategy is required.");
  const status = input.status === "archived" ? "archived" : "active";
  const { rowCount } = await pool.query(
    `UPDATE calculation_strategies SET status = $2, updated_at = now() WHERE id = $1`,
    [input.id, status],
  );
  if (rowCount === 0) return fail("not_found", "That strategy no longer exists.");
  await recordChange(pool, { actorId, action: status === "archived" ? "strategy_archived" : "strategy_restored", entityType: "calculation_strategy", entityId: input.id });
  return ok({ id: input.id });
}

export interface StrategyRevision {
  id: string;
  revision: number;
  snapshot: unknown;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export async function listStrategyRevisions(pool: PgLikePool, strategyId: string): Promise<StrategyRevision[]> {
  if (!UUID.test(strategyId)) return [];
  const { rows } = await pool.query<{
    id: string; revision: number; snapshot: unknown; reason: string | null; created_by_user_id: string | null; created_at: string;
  }>(
    `SELECT id, revision, snapshot, reason, created_by_user_id, created_at::text
       FROM calculation_strategy_revisions WHERE strategy_id = $1 ORDER BY revision DESC`,
    [strategyId],
  );
  return rows.map((r) => ({ id: r.id, revision: r.revision, snapshot: r.snapshot, reason: r.reason, createdBy: r.created_by_user_id, createdAt: r.created_at }));
}

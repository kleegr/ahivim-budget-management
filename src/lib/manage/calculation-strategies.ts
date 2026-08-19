import type { PgLikePool, PgLikeClient } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange } from "@/lib/manage/audit";
import { dec, toMoney, toHours } from "@/lib/money";
import {
  computeStrategy,
  currentBudgetPeriod,
  type StrategyResult,
} from "@/lib/business/calculation-strategy";
import { calculatePeriodElapsed, classifyUtilization, type UtilizationStatus } from "@/lib/business/utilization";
import { calculateForecast } from "@/lib/business/forecast";
import { resolveEffectiveRate } from "@/lib/business/rate-resolver";

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
  renewalDate: string | null; // the stored anniversary (what you edit)
  effectiveRenewal: string | null; // rolled forward to the current year for active accounts
  active: boolean; // the individual's account is active (auto-rolls its renewal)
  periodStart: string | null; // current budget year start (rolled)
  periodEnd: string | null; // current budget year end (rolled)
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
  analytics?: StrategyAnalytics;
}

/**
 * Live actual-vs-plan analytics for a strategy, joined from the billed ledger
 * and the schedule. Actuals reflect the strategy's canonical individual — so a
 * merged (name-matched) person's transactions count here, which is the whole
 * point of connecting the two workspaces.
 */
export interface StrategyAnalytics {
  plannedHours: string; // Σ program-line hours
  actualHours: string; // billed
  actualInternal: string;
  scheduledHours: string; // pending schedule
  scheduledInternal: string;
  remainingHours: string; // planned − actual − scheduled
  utilizationPercent: string | null; // actual / planned (fraction)
  committedPercent: string | null; // (actual + scheduled) / planned
  projectedExhaustion: string | null; // forecast date, when derivable
  workbookValue: string | null; // the workbook's After All (entered final figure)
  systemValue: string; // the system's step-by-step Net
  difference: string | null; // workbook − system
  warnings: string[];
  /** Canonical pace status (billed hours vs. time elapsed) — the row's one glance. */
  status: UtilizationStatus;
  /** Fraction (0–1) of the budget period elapsed, for the pace-bar notch. */
  timeElapsedPercent: string | null;
}

interface RateScheduleRow {
  program_id: string;
  internal_rate: string;
  effective_from: string;
}

/**
 * Each program's internal rate effective on `asOf`, via the ONE effective-dated
 * resolver (`@/lib/business/rate-resolver`). A null `asOf` means "the latest
 * configured rate" (used when a strategy has no renewal date yet). Returns "0"
 * when the program has no rate in force.
 */
function rateAsOf(schedules: RateScheduleRow[], programId: string, asOf: string | null): string {
  const forProgram = schedules
    .filter((s) => s.program_id === programId)
    .map((s) => ({ effectiveFrom: s.effective_from, internalRate: s.internal_rate }));
  const resolved = resolveEffectiveRate(forProgram, asOf ?? "9999-12-31");
  return resolved?.internalRate ?? "0";
}

export async function listProgramRates(pool: PgLikePool, asOf?: string | null): Promise<ProgramRate[]> {
  const { rows } = await pool.query<{ id: string; code: string; name: string; as_of: string }>(
    `SELECT p.id, p.code, p.name, COALESCE($1::date, CURRENT_DATE)::text AS as_of
       FROM programs p
      WHERE p.is_active IS DISTINCT FROM false
      ORDER BY p.code`,
    [asOf ?? null],
  );
  const { rows: schedules } = await pool.query<RateScheduleRow>(
    `SELECT program_id, internal_rate::text, to_char(effective_from,'YYYY-MM-DD') AS effective_from
       FROM program_rate_schedules`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    internalRate: rateAsOf(schedules, r.id, r.as_of),
  }));
}

/**
 * The effective internal rate for one strategy line, and whether the override
 * actually applied. A `rate_override` applies when it has no effective-from
 * (NULL — the legacy behaviour) OR the strategy's renewal date is on or after
 * that effective-from; otherwise the effective-dated schedule default is used.
 * With no renewal date to compare against, a dated override does not apply.
 */
function effectiveLineRate(args: {
  override: string | null;
  overrideEffectiveFrom: string | null;
  renewalDate: string | null;
  defaultRate: string;
}): { rate: string; isOverride: boolean } {
  const { override, overrideEffectiveFrom, renewalDate, defaultRate } = args;
  const overrideApplies =
    override != null &&
    (overrideEffectiveFrom == null ||
      (renewalDate != null && renewalDate >= overrideEffectiveFrom));
  return overrideApplies ? { rate: override, isOverride: true } : { rate: defaultRate, isOverride: false };
}

export async function listStrategies(
  pool: PgLikePool,
  opts: { individualId?: string; includeArchived?: boolean; withAnalytics?: boolean } = {},
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
    individual_status: string;
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
            i.status AS individual_status,
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
        await pool.query<{ strategy_id: string; program_id: string; authorized_hours: string; rate_override: string | null; rate_override_effective_from: string | null }>(
          `SELECT strategy_id, program_id, authorized_hours::text, rate_override::text,
                  to_char(rate_override_effective_from, 'YYYY-MM-DD') AS rate_override_effective_from
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
  const overrideByStrategy = new Map<string, Record<string, string | null>>();
  const overrideFromByStrategy = new Map<string, Record<string, string | null>>();
  for (const l of lines) {
    const m = hoursByStrategy.get(l.strategy_id) ?? {};
    m[l.program_id] = l.authorized_hours;
    hoursByStrategy.set(l.strategy_id, m);
    const o = overrideByStrategy.get(l.strategy_id) ?? {};
    o[l.program_id] = l.rate_override;
    overrideByStrategy.set(l.strategy_id, o);
    const of = overrideFromByStrategy.get(l.strategy_id) ?? {};
    of[l.program_id] = l.rate_override_effective_from;
    overrideFromByStrategy.set(l.strategy_id, of);
  }

  const rows: StrategyGridRow[] = strategies.map((s) => {
    const hours = hoursByStrategy.get(s.id) ?? {};
    const overrides = overrideByStrategy.get(s.id) ?? {};
    const overrideFroms = overrideFromByStrategy.get(s.id) ?? {};
    const active = s.individual_status === "active";
    const period = currentBudgetPeriod(s.renewal_date, active);
    const strategyLines = Object.entries(hours).map(([programId, h]) => {
      const def = rateAsOf(schedules, programId, s.renewal_date);
      const { rate, isOverride } = effectiveLineRate({
        override: overrides[programId] ?? null,
        overrideEffectiveFrom: overrideFroms[programId] ?? null,
        renewalDate: s.renewal_date,
        defaultRate: def,
      });
      return {
        programLabel: programId,
        programId,
        hours: h,
        internalRate: rate, // effective rate: override wins when in effect
        isOverride,
        defaultRate: def,
      };
    });
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
      effectiveRenewal: period.effectiveRenewal,
      active,
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

  if (opts.withAnalytics && rows.length > 0) {
    await attachStrategyAnalytics(pool, rows);
  }
  return { rows, programs };
}

/** Bulk actual-vs-plan analytics for a set of strategy rows (2 aggregate queries). */
async function attachStrategyAnalytics(pool: PgLikePool, rows: StrategyGridRow[]): Promise<void> {
  const individualIds = [...new Set(rows.map((r) => r.individualId))];

  // Billed actuals per (individual, program), WINDOWED to each individual's
  // current budget period — exactly like the Individuals budget board. Without
  // the window this summed the entire ledger history (several years) against a
  // single year's authorized hours, so the glance read 200–300% "used" and
  // contradicted the Individuals page. One period window makes them agree.
  // `observations` is the real transaction count, used to gate the forecast.
  const winByInd = new Map<string, { start: string; end: string }>();
  for (const r of rows) {
    if (r.periodStart && r.periodEnd && !winByInd.has(r.individualId)) {
      winByInd.set(r.individualId, { start: r.periodStart, end: r.periodEnd });
    }
  }
  const winIds = [...winByInd.keys()];
  const winStarts = winIds.map((id) => winByInd.get(id)!.start);
  const winEnds = winIds.map((id) => winByInd.get(id)!.end);
  // Window an individual's billed rows to their current budget period when we
  // know it; when a strategy has no period at all there is nothing to window to,
  // so those individuals fall back to their full billed history (a LEFT JOIN
  // that leaves the window null). This keeps paced budgets honest without
  // zeroing out plans that simply have no dated period.
  const billed = await pool.query<{ individual_id: string; program_id: string; hours: string; internal: string; observations: string }>(
    `WITH win AS (
       SELECT * FROM unnest($1::uuid[], $2::date[], $3::date[]) AS w(individual_id, start_date, end_date)
     )
     SELECT t.individual_id, t.program_id,
            COALESCE(sum(t.imported_hours),0)::text AS hours,
            COALESCE(sum(COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount,
                     t.internal_rate_applied * t.imported_hours, 0)),0)::text AS internal,
            count(*)::text AS observations
       FROM payroll_transactions t
       LEFT JOIN win w ON w.individual_id = t.individual_id
      WHERE t.individual_id = ANY($4::uuid[]) AND t.program_id IS NOT NULL
        AND (w.individual_id IS NULL OR (t.period_begin >= w.start_date AND t.period_begin <= w.end_date))
      GROUP BY t.individual_id, t.program_id`,
    [winIds, winStarts, winEnds, individualIds],
  );
  // Pending scheduled per (individual, program).
  const scheduled = await pool.query<{ individual_id: string; program_id: string; hours: string; internal: string }>(
    `SELECT sa.individual_id, ss.program_id,
            COALESCE(sum(sa.allocation_hours),0)::text AS hours,
            COALESCE(sum(sa.allocated_amount),0)::text AS internal
       FROM scheduled_allocations sa
       JOIN scheduled_sessions ss ON ss.id = sa.scheduled_session_id
      WHERE sa.individual_id = ANY($1::uuid[]) AND ss.status = 'pending' AND ss.program_id IS NOT NULL
      GROUP BY sa.individual_id, ss.program_id`,
    [individualIds],
  );

  const key = (i: string, p: string) => `${i}:${p}`;
  const billedMap = new Map<string, { hours: string; internal: string; observations: string }>();
  for (const r of billed.rows) billedMap.set(key(r.individual_id, r.program_id), { hours: r.hours, internal: r.internal, observations: r.observations });
  const schedMap = new Map<string, { hours: string; internal: string }>();
  for (const r of scheduled.rows) schedMap.set(key(r.individual_id, r.program_id), { hours: r.hours, internal: r.internal });

  for (const row of rows) {
    const programIds = Object.keys(row.hours);
    let planned = dec(0);
    let actualH = dec(0), actualI = dec(0), schedH = dec(0), schedI = dec(0);
    let observations = 0;
    for (const pid of programIds) {
      planned = planned.plus(dec(row.hours[pid] ?? 0));
      const b = billedMap.get(key(row.individualId, pid));
      if (b) { actualH = actualH.plus(dec(b.hours)); actualI = actualI.plus(dec(b.internal)); observations += Number(b.observations); }
      const s = schedMap.get(key(row.individualId, pid));
      if (s) { schedH = schedH.plus(dec(s.hours)); schedI = schedI.plus(dec(s.internal)); }
    }
    const remaining = planned.minus(actualH).minus(schedH);
    const util = planned.greaterThan(0) ? actualH.dividedBy(planned) : null;
    const committed = planned.greaterThan(0) ? actualH.plus(schedH).dividedBy(planned) : null;

    // The budget period elapsed once, reused for the forecast, the pace-bar
    // notch and the canonical status. Best-effort: a malformed period yields no
    // pacing rather than an error.
    let elapsed: ReturnType<typeof calculatePeriodElapsed> | null = null;
    if (row.periodStart && row.periodEnd) {
      try {
        elapsed = calculatePeriodElapsed({ startDate: row.periodStart, endDate: row.periodEnd });
      } catch {
        elapsed = null;
      }
    }

    // Forecast projected exhaustion. Pass the REAL billed-transaction count so a
    // strategy projection obeys the same 28-day / 3-observation guardrails that
    // forecast.ts enforces everywhere else — no forced minimum, no fabrication.
    let projectedExhaustion: string | null = null;
    if (elapsed && planned.greaterThan(0) && actualH.greaterThan(0)) {
      try {
        const f = calculateForecast({
          authorizedHours: toHours(planned),
          usedHours: toHours(actualH),
          elapsed,
          periodStartDate: row.periodStart!,
          observationCount: observations,
        });
        if (f.available) projectedExhaustion = f.estimatedExhaustionDate;
      } catch {
        /* forecast is best-effort */
      }
    }

    // The one-glance status: classify billed pace against time elapsed. Without a
    // real period or plan there is nothing to pace, so the row reads "not started".
    const status: UtilizationStatus =
      elapsed && planned.greaterThan(0) ? classifyUtilization(util ?? dec(0), elapsed) : "not_started";

    const warnings: string[] = [];
    if (committed && committed.greaterThan(1)) warnings.push("over-budget");
    if (util && util.isZero() && planned.greaterThan(0)) warnings.push("no actuals yet");
    if (remaining.isNegative()) warnings.push("plan exceeded");

    const workbookValue = row.afterAll;
    const systemValue = row.net;
    const difference = workbookValue == null ? null : toMoney(dec(workbookValue).minus(dec(systemValue)));

    row.analytics = {
      plannedHours: toHours(planned),
      actualHours: toHours(actualH),
      actualInternal: toMoney(actualI),
      scheduledHours: toHours(schedH),
      scheduledInternal: toMoney(schedI),
      remainingHours: toHours(remaining),
      utilizationPercent: util ? util.toString() : null,
      committedPercent: committed ? committed.toString() : null,
      projectedExhaustion,
      workbookValue,
      systemValue,
      difference,
      warnings,
      status,
      timeElapsedPercent: elapsed ? elapsed.timeElapsedPercent : null,
    };
  }
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
  const { rows: lines } = await pool.query<{ program_id: string; program_label: string; authorized_hours: string; rate_override: string | null; rate_override_effective_from: string | null }>(
    `SELECT csl.program_id, COALESCE(p.name, p.code) AS program_label, csl.authorized_hours::text, csl.rate_override::text,
            to_char(csl.rate_override_effective_from, 'YYYY-MM-DD') AS rate_override_effective_from
       FROM calculation_strategy_lines csl JOIN programs p ON p.id = csl.program_id
      WHERE csl.strategy_id = $1
      ORDER BY p.code`,
    [id],
  );
  const { rows: schedules } = await pool.query<RateScheduleRow>(
    `SELECT program_id, internal_rate::text, to_char(effective_from,'YYYY-MM-DD') AS effective_from
       FROM program_rate_schedules`,
  );
  return computeStrategy({
    lines: lines.map((l) => {
      const def = rateAsOf(schedules, l.program_id, s.renewal_date);
      const { rate, isOverride } = effectiveLineRate({
        override: l.rate_override,
        overrideEffectiveFrom: l.rate_override_effective_from,
        renewalDate: s.renewal_date,
        defaultRate: def,
      });
      return {
        programLabel: l.program_label,
        programId: l.program_id,
        hours: l.authorized_hours,
        internalRate: rate,
        isOverride,
        defaultRate: def,
      };
    }),
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
  rateOverrides?: Record<string, string | number | null>; // programId -> rate (null reverts to default)
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

    if (input.rateOverrides) {
      for (const [programId, rate] of Object.entries(input.rateOverrides)) {
        if (!UUID.test(programId)) continue;
        const value = rate === null || rate === "" ? null : toMoney(rate as string);
        // Upsert the line (create with 0 hours if the program isn't on the strategy yet)
        // so a rate can be set before hours; null reverts to the schedule default.
        await client.query(
          `INSERT INTO calculation_strategy_lines (strategy_id, program_id, authorized_hours, rate_override)
           VALUES ($1,$2,0,$3)
           ON CONFLICT (strategy_id, program_id) DO UPDATE SET rate_override = EXCLUDED.rate_override, updated_at = now()`,
          [input.id, programId, value],
        );
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

/**
 * THE ONE rate resolver.
 * ======================
 *
 * A program's rate is effective-dated: each `program_rate_schedules` row applies
 * from `effective_from` until `effective_to`, and an open-ended row (null
 * `effective_to`) applies indefinitely. This module is the SINGLE definition of
 * "which rate is in force on a given date", so the reporting read-model, the
 * calculation-strategy engine, the scheduling preview and the programs screen
 * all resolve a rate the same way rather than each re-deriving it slightly
 * differently.
 *
 * The rule (matching `data/queries.ts` `currentRatesByProgram`, the reference
 * semantics):
 *
 *   a row is IN FORCE on `asOf` when
 *       effective_from <= asOf
 *       AND (effective_to IS NULL OR effective_to >= asOf)
 *   and when several rows are in force the LATEST effective_from wins — so a
 *   correction is a newer row, never an edit to history.
 *
 * Pure and string-based: ISO dates (YYYY-MM-DD) compare lexically exactly as
 * they compare chronologically, and money stays a string so no decimal
 * precision is lost. Nothing here touches the database.
 */

/** One candidate schedule row. Extra columns are preserved by `pickEffectiveRateRow`. */
export interface RateScheduleRow {
  /** ISO date (YYYY-MM-DD) the rate takes effect. */
  effectiveFrom: string;
  /** ISO date the rate stops applying, or null/undefined for open-ended. */
  effectiveTo?: string | null;
  /** Agency (funding) rate; null for self-hire programs that never convert. */
  agencyRate?: string | null;
  /** Internal (employee) rate — always present. */
  internalRate: string;
}

export interface ResolvedRate {
  agencyRate: string | null;
  internalRate: string;
}

/**
 * From a set of schedule rows FOR ONE PROGRAM, return the row in force on
 * `asOf`, or null when none is. "In force" is the effective_to window above;
 * a tie on `effective_from` keeps the first row given (deterministic), though
 * real schedules never overlap on the same `effective_from`.
 *
 * Generic so callers keep any extra columns (program_id, effective_from, …) on
 * the returned row.
 */
export function pickEffectiveRateRow<T extends RateScheduleRow>(
  rows: readonly T[],
  asOf: string,
): T | null {
  let chosen: T | null = null;
  for (const row of rows) {
    // Not yet in effect.
    if (row.effectiveFrom > asOf) continue;
    // Window closed before asOf (open-ended rows — null effective_to — never close).
    if (row.effectiveTo != null && row.effectiveTo < asOf) continue;
    // Latest effective_from wins; keep the first among equal dates.
    if (chosen === null || row.effectiveFrom > chosen.effectiveFrom) chosen = row;
  }
  return chosen;
}

/**
 * The effective rate on `asOf`, as `{ agencyRate, internalRate }`, or null when
 * no row is in force. `agencyRate` is null for non-converting (self-hire) rows.
 */
export function resolveEffectiveRate(
  rows: readonly RateScheduleRow[],
  asOf: string,
): ResolvedRate | null {
  const chosen = pickEffectiveRateRow(rows, asOf);
  if (chosen === null) return null;
  return {
    agencyRate: chosen.agencyRate ?? null,
    internalRate: chosen.internalRate,
  };
}

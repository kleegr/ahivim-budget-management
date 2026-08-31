import type { PgLikePool } from "@/lib/import/commit";
import { dec, toHours } from "@/lib/money";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SeriesAuthorizationInput {
  programId: string;
  individualIds: string[];
  occurrenceDates: string[];
  durationHours: string;
  excludeSessionId?: string | null;
  /** Pending unmatched rows from this series are being replaced on/after this date. */
  excludeSeriesId?: string | null;
  excludeSeriesFromDate?: string | null;
}

export interface SeriesAuthorizationPeriod {
  periodId: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  authorizedHours: string;
  actualHours: string | null;
  scheduledHours: string | null;
  seriesOccurrenceCount: number;
  seriesHours: string;
  remainingAfterHours: string | null;
  calculationSafe: boolean;
  sourceCandidateCount: number;
  sourceAmbiguous: boolean;
}

export interface IndividualSeriesAuthorization {
  individualId: string;
  individualName: string;
  periods: SeriesAuthorizationPeriod[];
  uncoveredOccurrenceCount: number;
  uncoveredHours: string;
  ambiguousOccurrenceCount: number;
  ambiguousHours: string;
  projectionSafe: boolean;
}

export interface SeriesAuthorizationResult {
  occurrenceCount: number;
  durationHours: string;
  individuals: IndividualSeriesAuthorization[];
}

interface IndividualRow {
  individual_id: string;
  individual_name: string;
}

interface AuthorizationRow {
  individual_id: string;
  period_id: string;
  period_label: string;
  start_date: string;
  end_date: string;
  authorized_hours: string;
  actual_hours: string;
  scheduled_hours: string;
  source_candidate_count: number | string;
}

/**
 * Bucket each proposed occurrence into the active authorization period that
 * covers it. Every returned value is a date, count, identity, or hour figure.
 */
export async function projectSeriesAuthorization(
  pool: PgLikePool,
  input: SeriesAuthorizationInput,
): Promise<SeriesAuthorizationResult> {
  const individualIds = [...new Set(input.individualIds)];
  const occurrenceDates = [...new Set(input.occurrenceDates)].sort();
  let durationHours: string;
  try {
    const duration = dec(input.durationHours);
    if (!duration.isFinite() || duration.lte(0)) throw new Error("invalid duration");
    durationHours = toHours(duration);
  } catch {
    return { occurrenceCount: occurrenceDates.length, durationHours: "0.0000", individuals: [] };
  }

  if (
    !UUID_RE.test(input.programId)
    || individualIds.length === 0
    || individualIds.some((id) => !UUID_RE.test(id))
    || occurrenceDates.length === 0
    || occurrenceDates.some((date) => !DATE_RE.test(date))
  ) {
    return { occurrenceCount: occurrenceDates.length, durationHours, individuals: [] };
  }

  const people = await pool.query<IndividualRow>(
    `SELECT id AS individual_id, display_name AS individual_name
       FROM individuals
      WHERE id = ANY($1::uuid[])
      ORDER BY lower(display_name), id`,
    [individualIds],
  );
  const excludeSessionId = input.excludeSessionId && UUID_RE.test(input.excludeSessionId)
    ? input.excludeSessionId
    : null;
  const excludeSeriesId = input.excludeSeriesId && UUID_RE.test(input.excludeSeriesId)
    ? input.excludeSeriesId
    : null;
  const excludeSeriesFromDate = excludeSeriesId
    && input.excludeSeriesFromDate
    && DATE_RE.test(input.excludeSeriesFromDate)
    ? input.excludeSeriesFromDate
    : occurrenceDates[0]!;
  const authorizations = await pool.query<AuthorizationRow>(
    `WITH occurrence_dates AS (
       SELECT DISTINCT unnest($3::date[]) AS occurrence_date
     ), effective_authorizations AS (
       SELECT DISTINCT ea.individual_id, ea.period_id, ea.period_label,
              ea.start_date, ea.end_date, ea.authorized_hours, ea.internal_rate,
              ea.source_candidate_count
         FROM occurrence_dates dates
         CROSS JOIN LATERAL effective_budget_authorizations_at(dates.occurrence_date) ea
        WHERE ea.individual_id = ANY($1::uuid[])
          AND ea.program_id = $2::uuid
     )
     SELECT ea.individual_id, ea.period_id, ea.period_label,
            ea.start_date::text AS start_date, ea.end_date::text AS end_date,
            ea.authorized_hours::text AS authorized_hours,
            ea.source_candidate_count,
            effective_billed_hours(
              ea.individual_id, $2::uuid, ea.start_date, ea.end_date, ea.internal_rate
            )::text AS actual_hours,
            COALESCE((
              SELECT sum(sa.allocation_hours)
                FROM scheduled_allocations sa
                JOIN scheduled_sessions s ON s.id = sa.scheduled_session_id
               WHERE sa.individual_id = ea.individual_id
                 AND s.program_id = $2::uuid
                 AND s.status = 'pending'
                 AND s.matched_transaction_id IS NULL
                 AND s.session_date BETWEEN ea.start_date AND ea.end_date
                 AND ($4::uuid IS NULL OR s.id <> $4::uuid)
                 AND (
                   $5::uuid IS NULL
                   OR s.series_id IS DISTINCT FROM $5::uuid
                   OR s.session_date < $6::date
                 )
            ), 0)::text AS scheduled_hours
       FROM effective_authorizations ea
      ORDER BY ea.individual_id, ea.start_date, ea.end_date, ea.period_id`,
    [
      individualIds,
      input.programId,
      occurrenceDates,
      excludeSessionId,
      excludeSeriesId,
      excludeSeriesFromDate,
    ],
  );

  const names = new Map(people.rows.map((person) => [person.individual_id, person.individual_name]));
  const rowsByIndividual = new Map<string, AuthorizationRow[]>();
  for (const row of authorizations.rows) {
    const rows = rowsByIndividual.get(row.individual_id) ?? [];
    rows.push(row);
    rowsByIndividual.set(row.individual_id, rows);
  }

  const individuals = individualIds.map((individualId): IndividualSeriesAuthorization => {
    const rows = rowsByIndividual.get(individualId) ?? [];
    const unsafePeriodIds = overlappingPeriodIds(rows);
    const occurrenceCounts = new Map<string, number>();
    const includedPeriodIds = new Set<string>();
    let uncoveredOccurrenceCount = 0;
    let ambiguousOccurrenceCount = 0;

    for (const date of occurrenceDates) {
      const covering = rows.filter((row) => row.start_date <= date && row.end_date >= date);
      for (const row of covering) includedPeriodIds.add(row.period_id);
      if (covering.length === 0) {
        uncoveredOccurrenceCount += 1;
      } else if (covering.length > 1) {
        ambiguousOccurrenceCount += 1;
      } else {
        const periodId = covering[0]!.period_id;
        occurrenceCounts.set(periodId, (occurrenceCounts.get(periodId) ?? 0) + 1);
      }
    }

    const periods = rows
      .filter((row) => includedPeriodIds.has(row.period_id))
      .map((row): SeriesAuthorizationPeriod => {
        const seriesOccurrenceCount = occurrenceCounts.get(row.period_id) ?? 0;
        const seriesHours = dec(durationHours).times(seriesOccurrenceCount);
        const calculationSafe = !unsafePeriodIds.has(row.period_id);
        const sourceCandidateCount = Number(row.source_candidate_count ?? 1);
        const remaining = calculationSafe
          ? dec(row.authorized_hours)
            .minus(dec(row.actual_hours))
            .minus(dec(row.scheduled_hours))
            .minus(seriesHours)
          : null;
        return {
          periodId: row.period_id,
          periodLabel: row.period_label,
          startDate: row.start_date,
          endDate: row.end_date,
          authorizedHours: toHours(row.authorized_hours),
          actualHours: calculationSafe ? toHours(row.actual_hours) : null,
          scheduledHours: calculationSafe ? toHours(row.scheduled_hours) : null,
          seriesOccurrenceCount,
          seriesHours: toHours(seriesHours),
          remainingAfterHours: remaining === null ? null : toHours(remaining),
          calculationSafe,
          sourceCandidateCount,
          sourceAmbiguous: sourceCandidateCount > 1,
        };
      });

    return {
      individualId,
      individualName: names.get(individualId) ?? "Individual",
      periods,
      uncoveredOccurrenceCount,
      uncoveredHours: toHours(dec(durationHours).times(uncoveredOccurrenceCount)),
      ambiguousOccurrenceCount,
      ambiguousHours: toHours(dec(durationHours).times(ambiguousOccurrenceCount)),
      projectionSafe: uncoveredOccurrenceCount === 0
        && ambiguousOccurrenceCount === 0
        && periods.every((period) => period.calculationSafe && !period.sourceAmbiguous),
    };
  });

  return { occurrenceCount: occurrenceDates.length, durationHours, individuals };
}

function overlappingPeriodIds(rows: AuthorizationRow[]): Set<string> {
  const overlapping = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < rows.length; otherIndex += 1) {
      const left = rows[index]!;
      const right = rows[otherIndex]!;
      if (left.start_date <= right.end_date && right.start_date <= left.end_date) {
        overlapping.add(left.period_id);
        overlapping.add(right.period_id);
      }
    }
  }
  return overlapping;
}

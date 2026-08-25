import { timesOverlap } from "@/lib/business/scheduling";
import type { PgLikePool } from "@/lib/import/commit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface IndividualConflictInput {
  individualIds: string[];
  sessionDates: string[];
  startTime: string | null;
  endTime: string | null;
  excludeSessionId?: string | null;
  excludeSeriesId?: string | null;
  excludeSeriesFromDate?: string | null;
}

export interface IndividualConflictSignal {
  individualId: string;
  individualName: string;
  conflictCount: number;
  conflictingOccurrenceCount: number;
  conflictingDates: string[];
}

export interface IndividualConflictResult {
  occurrenceCount: number;
  individuals: IndividualConflictSignal[];
}

interface ConflictRow {
  individual_id: string;
  individual_name: string;
  session_date: string;
  start_time: string | null;
  end_time: string | null;
}

/**
 * Find selected-individual clashes across every proposed occurrence. The DTO is
 * deliberately limited to identities, dates, and counts for the planner.
 */
export async function listIndividualScheduleConflicts(
  pool: PgLikePool,
  input: IndividualConflictInput,
): Promise<IndividualConflictResult> {
  const individualIds = [...new Set(input.individualIds)].filter((id) => UUID_RE.test(id));
  const sessionDates = [...new Set(input.sessionDates)].filter((date) => DATE_RE.test(date)).sort();
  if (individualIds.length === 0 || sessionDates.length === 0) {
    return { occurrenceCount: sessionDates.length, individuals: [] };
  }

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
    : sessionDates[0]!;
  const { rows } = await pool.query<ConflictRow>(
    `SELECT allocation.individual_id, individual.display_name AS individual_name,
            session.session_date::text AS session_date,
            session.start_time, session.end_time
       FROM scheduled_allocations allocation
       JOIN scheduled_sessions session ON session.id = allocation.scheduled_session_id
       JOIN individuals individual ON individual.id = allocation.individual_id
      WHERE allocation.individual_id = ANY($1::uuid[])
        AND session.session_date = ANY($2::date[])
        AND session.status IN ('pending', 'completed')
        AND session.archived_at IS NULL
        AND ($3::uuid IS NULL OR session.id <> $3::uuid)
        AND (
          $4::uuid IS NULL
          OR session.series_id IS DISTINCT FROM $4::uuid
          OR session.session_date < $5::date
          OR session.status <> 'pending'
        )
      ORDER BY individual.display_name, session.session_date, session.id`,
    [individualIds, sessionDates, excludeSessionId, excludeSeriesId, excludeSeriesFromDate],
  );

  const signals = new Map<string, IndividualConflictSignal>();
  for (const row of rows) {
    if (!timesOverlap(input.startTime, input.endTime, row.start_time, row.end_time)) continue;
    const signal = signals.get(row.individual_id) ?? {
      individualId: row.individual_id,
      individualName: row.individual_name,
      conflictCount: 0,
      conflictingOccurrenceCount: 0,
      conflictingDates: [],
    };
    signal.conflictCount += 1;
    if (!signal.conflictingDates.includes(row.session_date)) {
      signal.conflictingDates.push(row.session_date);
      signal.conflictingOccurrenceCount += 1;
    }
    signals.set(row.individual_id, signal);
  }

  return {
    occurrenceCount: sessionDates.length,
    individuals: [...signals.values()],
  };
}

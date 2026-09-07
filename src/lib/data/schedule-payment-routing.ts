import type { PgLikePool } from "@/lib/import/commit";

type ScheduleRoutingQueryable = Pick<PgLikePool, "query">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SchedulePaymentRecipient = "employee" | "excellent_staffing" | "unknown";

export interface SchedulePaymentRoutingInput {
  employeeId: string;
  programId: string;
  onDate: string;
}

export interface SchedulePaymentRoutingDatesInput {
  employeeId: string;
  programId: string;
  onDates: string[];
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function recipient(value: unknown): SchedulePaymentRecipient {
  return value === "employee" || value === "excellent_staffing" ? value : "unknown";
}

/**
 * Resolve planned work from Program configuration only. Transaction-level
 * routing describes what actually happened and must not become configuration
 * for a later scheduled visit.
 *
 * Callers must pass a trusted SQL expression, never request data.
 */
export function configuredSchedulePaymentRecipientSql(programExpression: string): string {
  return `effective_payment_recipient(NULL::text, ${programExpression})`;
}

/**
 * Resolve the one canonical payment route for an employee/program/date.
 * The current Program rule is the sole routing source because the application
 * does not yet have effective-dated planned-routing configuration.
 */
export async function resolveSchedulePaymentRecipient(
  pool: ScheduleRoutingQueryable,
  input: SchedulePaymentRoutingInput,
): Promise<SchedulePaymentRecipient> {
  const rows = await resolveSchedulePaymentRecipients(pool, {
    employeeId: input.employeeId,
    programId: input.programId,
    onDates: [input.onDate],
  });
  return rows.get(input.onDate) ?? "unknown";
}

/** Resolve several occurrence dates with one bounded query for series preview. */
export async function resolveSchedulePaymentRecipients(
  pool: ScheduleRoutingQueryable,
  input: SchedulePaymentRoutingDatesInput,
): Promise<Map<string, SchedulePaymentRecipient>> {
  const onDates = [...new Set(input.onDates)].sort();
  if (
    !UUID.test(input.employeeId)
    || !UUID.test(input.programId)
    || onDates.length === 0
    || onDates.some((date) => !validDate(date))
  ) {
    return new Map();
  }

  const { rows } = await pool.query<{ on_date: string; payment_recipient: string | null }>(
    `WITH requested_dates AS (
       SELECT DISTINCT unnest($2::date[]) AS on_date
     )
     SELECT requested.on_date::text AS on_date,
             ${configuredSchedulePaymentRecipientSql("program.payment_recipient")} AS payment_recipient
       FROM requested_dates requested
       JOIN programs program ON program.id = $1::uuid
      ORDER BY requested.on_date`,
    [input.programId, onDates],
  );

  return new Map(rows.map((row) => [row.on_date, recipient(row.payment_recipient)]));
}

import { dec, toMoney, toHours, type MoneyInput } from "@/lib/money";

/**
 * SCHEDULING MATH (pure, decimal-safe).
 *
 * Expected billing for a PLANNED session, the recurrence expansion for a
 * series, and time-overlap for conflict detection. No database, no dates from
 * the clock passed implicitly — everything is an argument so it is testable.
 *
 * Money rule, identical to the imported group rule: on a group session every
 * individual is credited the FULL session hours; only the money divides.
 */

export interface ExpectedBillingInput {
  hours: MoneyInput;
  groupSize?: number;
  /** Agency rate for the program on the session date, or null for self-hire. */
  agencyRate?: MoneyInput | null;
  /** Internal rate for the program on the session date. */
  internalRate: MoneyInput;
}

export interface ExpectedBilling {
  /** Rate used to price the session (agency rate, or internal for self-hire). */
  expectedRate: string;
  /** Whole-session agency gross (group: summed across members). */
  agencyGross: string;
  /** Whole-session internal amount (group: summed across members). */
  internalAmount: string;
  /** Whole-session agency additional = agency gross - internal (0 for self-hire). */
  agencyAdditional: string;
  /** Per-individual allocation: full hours, one member's share of the money. */
  perIndividual: { hours: string; rate: string; amount: string };
}

/**
 * Value a planned session from the authorized rates. Agency gross uses the
 * agency rate; internal uses hours x internal rate — the same basis
 * authorizations use to value hours, so a forecast lines up with the
 * authorization it draws down. Self-hire has no agency rate and does not
 * convert (agency == internal).
 */
export function expectedBilling(input: ExpectedBillingInput): ExpectedBilling {
  const size = Math.max(1, Math.floor(input.groupSize ?? 1));
  const hours = dec(input.hours);
  const internalRate = dec(input.internalRate);
  const hasAgency = input.agencyRate !== null && input.agencyRate !== undefined && input.agencyRate !== "";
  const agencyRate = hasAgency ? dec(input.agencyRate as MoneyInput) : internalRate;

  // Per individual: full hours, valued at the program rates.
  const perAgency = hours.times(agencyRate);
  const perInternal = hours.times(internalRate);

  return {
    expectedRate: toMoney(hasAgency ? agencyRate : internalRate),
    agencyGross: toMoney(perAgency.times(size)),
    internalAmount: toMoney(perInternal.times(size)),
    // Agency additional is what the agency keeps above the internal (employee)
    // rate. Self-hire has no agency rate, so agency == internal and this is 0.
    agencyAdditional: toMoney(perAgency.minus(perInternal).times(size)),
    perIndividual: {
      hours: toHours(hours),
      rate: toMoney(internalRate),
      amount: toMoney(perInternal),
    },
  };
}

/** Parse "HH:MM" to minutes since midnight, or null. */
export function minutesOf(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Duration in hours between two HH:MM times (handles same-day only). */
export function durationBetween(start: string | null, end: string | null): string | null {
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === null || e === null || e <= s) return null;
  return toHours(dec(e - s).dividedBy(60));
}

/**
 * Do two sessions on the same date overlap in time? If either lacks times we
 * treat it as occupying the whole day, so a same-date clash is still flagged.
 */
export function timesOverlap(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
): boolean {
  const as = minutesOf(aStart);
  const ae = minutesOf(aEnd);
  const bs = minutesOf(bStart);
  const be = minutesOf(bEnd);
  if (as === null || ae === null || bs === null || be === null) return true;
  return as < be && bs < ae;
}

export interface RecurrenceInput {
  frequency: "weekly" | "daily";
  interval?: number;
  /** 0=Sunday..6=Saturday. Required for weekly; ignored for daily. */
  weekdays?: number[];
  startDate: string; // YYYY-MM-DD
  endDate: string;
  /** Safety cap so a bad range can't generate an unbounded series. */
  max?: number;
}

/** Expand a recurrence into concrete ISO dates (inclusive of both ends). */
export function generateOccurrences(input: RecurrenceInput): string[] {
  const start = parseISO(input.startDate);
  const end = parseISO(input.endDate);
  if (!start || !end || end < start) return [];
  const interval = Math.max(1, Math.floor(input.interval ?? 1));
  const cap = Math.max(1, Math.min(input.max ?? 400, 400));
  const weekdays = new Set((input.weekdays ?? []).filter((d) => d >= 0 && d <= 6));

  const out: string[] = [];
  if (input.frequency === "daily") {
    for (let d = new Date(start); d <= end && out.length < cap; d.setUTCDate(d.getUTCDate() + interval)) {
      out.push(isoOf(d));
    }
    return out;
  }
  // weekly: step day by day within each week that is `interval` weeks from the
  // anchor week, emitting the selected weekdays.
  if (weekdays.size === 0) weekdays.add(start.getUTCDay());
  const anchorWeek = weekIndex(start);
  for (let d = new Date(start); d <= end && out.length < cap; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!weekdays.has(d.getUTCDay())) continue;
    if ((weekIndex(d) - anchorWeek) % interval !== 0) continue;
    out.push(isoOf(d));
  }
  return out;
}

function parseISO(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function weekIndex(d: Date): number {
  // whole-weeks since epoch, Sunday-based.
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000 + 4) / 7);
}

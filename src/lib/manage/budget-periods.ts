/**
 * BUDGET-PERIOD DATE DERIVATION
 * =============================
 *
 * A budget period is one of three shapes:
 *
 *   calendar  a plain calendar year: 1 Jan .. 31 Dec of some year.
 *   rolling   twelve months from a start date: start .. start + 12 months − 1 day.
 *   custom    an explicit start and end, supplied verbatim by the caller.
 *
 * `derivePeriodDates` is PURE and covers the two shapes it can derive from a
 * single date. Custom periods keep their explicit end date; the function still
 * accepts `custom` and echoes the start so callers have one uniform entry point.
 */

export type PeriodType = "calendar" | "rolling" | "custom";

export const PERIOD_TYPES: PeriodType[] = ["calendar", "rolling", "custom"];

export const PERIOD_TYPE_LABELS: Record<PeriodType, string> = {
  calendar: "Calendar year (Jan 1 – Dec 31)",
  rolling: "Rolling 12 months",
  custom: "Custom range",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function pad4(year: number): string {
  return String(year).padStart(4, "0");
}

/** Add one calendar year and subtract a day, e.g. 2025-03-15 -> 2026-03-14. */
function twelveMonthsMinusDay(startDate: string): string {
  const year = Number(startDate.slice(0, 4));
  const month = Number(startDate.slice(5, 7)); // 1-based
  const day = Number(startDate.slice(8, 10));
  // Anchor a year on from the start date (UTC, so no timezone drift), then step
  // back one day. Date.UTC clamps an impossible day (e.g. next year's Feb 29)
  // forward, so the result is the correct "twelve months minus a day".
  const anchor = Date.UTC(year + 1, month - 1, day);
  const end = new Date(anchor - 24 * 60 * 60 * 1000);
  return end.toISOString().slice(0, 10);
}

/**
 * Derive the concrete start and end dates for a period.
 *
 * For `calendar`, the year is taken from the explicit `year` argument when
 * given, otherwise from the year component of `startDate`. For `rolling`, the
 * end date is twelve months on from the start, minus a day. For `custom`, the
 * caller owns the end date; this returns the start unchanged for both fields.
 */
export function derivePeriodDates(
  periodType: PeriodType,
  startDate: string | null | undefined,
  year?: number | null,
): { startDate: string; endDate: string } {
  const start = (startDate ?? "").trim();

  if (periodType === "calendar") {
    const resolvedYear =
      year !== undefined && year !== null ? year : ISO_DATE.test(start) ? Number(start.slice(0, 4)) : NaN;
    if (!Number.isInteger(resolvedYear) || resolvedYear < 1 || resolvedYear > 9999) {
      throw new RangeError("A calendar period needs a valid year (or a start date to take it from).");
    }
    return { startDate: `${pad4(resolvedYear)}-01-01`, endDate: `${pad4(resolvedYear)}-12-31` };
  }

  if (periodType === "rolling") {
    if (!ISO_DATE.test(start)) {
      throw new RangeError("A rolling period needs a start date (YYYY-MM-DD).");
    }
    return { startDate: start, endDate: twelveMonthsMinusDay(start) };
  }

  // custom
  if (!ISO_DATE.test(start)) {
    throw new RangeError("A custom period needs a start date (YYYY-MM-DD).");
  }
  return { startDate: start, endDate: start };
}

import { generateOccurrences, type RecurrenceInput } from "@/lib/business/scheduling";
import { dec, toHours } from "@/lib/money";

export interface SeriesProjection {
  dates: string[];
  occurrenceCount: number;
  totalHours: string | null;
}

/** Expand a proposed series and total the hours charged to each authorization. */
export function projectSeries(
  recurrence: RecurrenceInput,
  durationHours: string,
): SeriesProjection {
  const dates = recurrence.frequency === "weekly" && (recurrence.weekdays?.length ?? 0) === 0
    ? []
    : generateOccurrences(recurrence);

  let totalHours: string | null = null;
  try {
    const duration = dec(durationHours);
    if (duration.isFinite() && duration.gt(0) && dates.length > 0) {
      totalHours = toHours(duration.times(dates.length));
    }
  } catch {
    // The form keeps the projection empty while a partial numeric value is typed.
  }

  return { dates, occurrenceCount: dates.length, totalHours };
}

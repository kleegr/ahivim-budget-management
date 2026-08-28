export const AGENCY_TIME_ZONE = "America/New_York";

const agencyDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: AGENCY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date used for Ahivim operations, independent of server location. */
export function agencyDate(at: Date = new Date()): string {
  const parts = agencyDateFormatter.formatToParts(at);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not resolve the agency business date.");
  return `${year}-${month}-${day}`;
}

export function agencyMonth(at: Date = new Date()): string {
  return agencyDate(at).slice(0, 7);
}

/**
 * Canonical service-date precedence shared with database function
 * `canonical_service_date`: period begin, then check date, then period end.
 * A missing date stays missing for utilization; callers may choose an explicit
 * fallback for a separate concern such as selecting an import-time rate.
 */
export function canonicalServiceDate(input: {
  periodBegin?: string | null;
  checkDate?: string | null;
  periodEnd?: string | null;
}): string | null {
  return input.periodBegin || input.checkDate || input.periodEnd || null;
}

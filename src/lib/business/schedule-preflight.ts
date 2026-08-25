import type { EmployeeAvailabilityResult } from "@/lib/data/employee-availability";
import type { IndividualConflictResult } from "@/lib/data/individual-schedule-conflicts";
import type { SeriesAuthorizationResult } from "@/lib/data/series-authorization";
import type { SessionPreview } from "@/lib/manage/schedule";
import { dec } from "@/lib/money";

export interface PlanningSchedulePreview extends SessionPreview {
  employeeAvailability: EmployeeAvailabilityResult;
  individualConflicts: IndividualConflictResult;
  seriesAuthorization: SeriesAuthorizationResult | null;
  validationMessage: string | null;
}

export interface SchedulePreflightOptions {
  recurring: boolean;
  selectedEmployeeId: string;
}

/** True when the current live preview needs a written planner explanation. */
export function schedulePreviewRequiresOverride(
  preview: PlanningSchedulePreview,
  options: SchedulePreflightOptions,
): boolean {
  if (preview.warnings.length > 0) return true;
  if (preview.individualConflicts.individuals.some((individual) => individual.conflictingOccurrenceCount > 0)) {
    return true;
  }

  const selectedEmployee = options.selectedEmployeeId
    ? preview.employeeAvailability.employees.find((employee) => employee.employeeId === options.selectedEmployeeId)
    : null;
  if (selectedEmployee && (!selectedEmployee.assignedToAll || selectedEmployee.conflictingOccurrenceCount > 0)) {
    return true;
  }

  if (!options.recurring) {
    return preview.forecast.some((forecast) =>
      forecast.remainingAfterHours !== null && dec(forecast.remainingAfterHours).isNegative());
  }

  return (preview.seriesAuthorization?.individuals ?? []).some((individual) =>
    !individual.projectionSafe
    || individual.periods.some((period) =>
      !period.calculationSafe
      || (period.remainingAfterHours !== null && dec(period.remainingAfterHours).isNegative())));
}

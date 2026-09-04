import type { EmployeeAvailability } from "@/lib/data/employee-availability";

/** Compact, consistent planner copy for an employee candidate. */
export function employeeAvailabilityLabel(
  employee: EmployeeAvailability,
  timeRangeKnown: boolean,
  occurrenceCount: number,
): string {
  const missingAssignments = Math.max(0, occurrenceCount - employee.assignedOccurrenceCount);
  const busy = employee.conflictingOccurrenceCount > 0
    ? `; busy on ${employee.conflictingOccurrenceCount} visit${employee.conflictingOccurrenceCount === 1 ? "" : "s"}`
    : "";
  if (!employee.assignedToAll) {
    return `Not assigned on ${missingAssignments} visit${missingAssignments === 1 ? "" : "s"}${busy}`;
  }
  if (!timeRangeKnown) return "Assigned; set start and end times";
  if (employee.unavailableOccurrenceCount > 0) {
    return `Unavailable on ${employee.unavailableOccurrenceCount} visit${employee.unavailableOccurrenceCount === 1 ? "" : "s"}`;
  }
  if (employee.outsideDeclaredAvailabilityOccurrenceCount > 0) {
    return `Outside working hours on ${employee.outsideDeclaredAvailabilityOccurrenceCount} visit${employee.outsideDeclaredAvailabilityOccurrenceCount === 1 ? "" : "s"}`;
  }
  if (employee.conflictingOccurrenceCount > 0) {
    return `Busy on ${employee.conflictingOccurrenceCount} visit${employee.conflictingOccurrenceCount === 1 ? "" : "s"}`;
  }
  if (employee.undeclaredAvailabilityOccurrenceCount > 0) {
    return `Available; hours not entered for ${employee.undeclaredAvailabilityOccurrenceCount} visit${employee.undeclaredAvailabilityOccurrenceCount === 1 ? "" : "s"}`;
  }
  return "Available";
}

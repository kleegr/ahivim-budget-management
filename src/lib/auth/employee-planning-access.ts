import type { EmployeeRecord } from "@/lib/manage/employees";

export interface PlanningEmployeeProfile {
  id: string;
  displayName: string;
  status: string;
  archivedAt: string | null;
}

/** Exact employee profile shape exposed to an hours-only planning account. */
export function planningEmployeeProfile(record: EmployeeRecord): PlanningEmployeeProfile {
  return {
    id: record.id,
    displayName: record.displayName,
    status: record.status,
    archivedAt: record.archivedAt,
  };
}

import { hasDirectEmployeeAccess, hasDirectIndividualAccess, type AccessScope } from "./access";
import { planningEmployeeProfile, type PlanningEmployeeProfile } from "./employee-planning-access";
import type { EmployeeRecord } from "@/lib/manage/employees";
import type { IndividualRecord } from "@/lib/manage/individuals";

/** Free-form source notes are not classified by category. Keep them internal. */
export function individualRecordForAccess(scope: AccessScope, record: IndividualRecord): IndividualRecord {
  if (scope.role === "admin" || scope.role === "manager") return record;
  const direct = hasDirectIndividualAccess(scope, record.id);
  return {
    id: record.id,
    displayName: record.displayName,
    legalName: direct ? record.legalName : null,
    preferredName: direct ? record.preferredName : null,
    normalizedName: record.normalizedName,
    externalRef: null,
    status: record.status,
    notes: null,
    phone: direct ? record.phone : null,
    category: direct ? record.category : null,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
  };
}

/** Connected navigation never conveys payroll references or private deal notes. */
export function employeeRecordForAccess(scope: AccessScope, record: EmployeeRecord): EmployeeRecord | PlanningEmployeeProfile {
  if (scope.role === "admin" || scope.role === "manager"
    || (scope.canSeeMoney && scope.canSeeEmployeeDeals && hasDirectEmployeeAccess(scope, record.id))) return record;
  return planningEmployeeProfile(record);
}

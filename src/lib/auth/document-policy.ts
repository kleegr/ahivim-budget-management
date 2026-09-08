import type { AccessScope, VisibilityPermissions } from "./access";
const SUBJECT_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const SUBJECT_ID = new RegExp(SUBJECT_ID_PATTERN, "i");

export const DOCUMENT_VISIBILITY: (keyof VisibilityPermissions)[] = [
  "canSeeMoney", "canSeeHours", "canSeeBilledAmounts", "canSeeEmployeeAmounts", "canSeeAgencySpread",
  "canSeeCheckGross", "canSeeCheckNet", "canSeeTaxes", "canSeeBudgets", "canSeeEmployeeDeals", "canSeeSettlements", "canSeeClassFinancials",
];

/** Trusted creation provenance or an explicit Owner classification, never the display category. */
export interface DocumentAccessContext {
  kind: "owner" | "private" | "classes" | "planning" | "payroll" | "settlements";
  individualId?: string;
  employeeId?: string;
  sourceInvoiceId?: string;
  requiredCapabilities?: (keyof VisibilityPermissions)[];
}

export interface DocumentPolicyRecord {
  createdByUserId: string;
  accessContext: DocumentAccessContext | null;
}

export function canAccessDocumentSource(scope: AccessScope, document: DocumentPolicyRecord): boolean {
  if (!scope.canViewDocuments) return false;
  if (scope.role === "admin" && scope.full) return true;
  const context = document.accessContext;
  if (!context || context.kind === "owner") return false;
  if (context.individualId !== undefined && (typeof context.individualId !== "string" || !SUBJECT_ID.test(context.individualId))) return false;
  if (context.employeeId !== undefined && (typeof context.employeeId !== "string" || !SUBJECT_ID.test(context.employeeId))) return false;
  if (context.individualId && !(scope.allIndividuals || scope.grantedIndividualIds.includes(context.individualId))) return false;
  if (context.employeeId && !(scope.allEmployees || scope.grantedEmployeeIds.includes(context.employeeId))) return false;
  if (context.kind === "private") return document.createdByUserId === scope.userId && scope.canEditDocuments
    && Array.isArray(context.requiredCapabilities) && context.requiredCapabilities.every((capability) => DOCUMENT_VISIBILITY.includes(capability) && scope[capability]);
  switch (context.kind) {
    case "classes": return Boolean(context.individualId) && scope.canSeeMoney && scope.canSeeClassFinancials;
    case "planning": return Boolean(context.individualId) && scope.canPlan && scope.canSeeHours && scope.canSeeBudgets;
    case "payroll": return Boolean(context.employeeId) && scope.canSeeMoney && scope.canSeeTransactions
      && scope.canSeeEmployeeAmounts && scope.canSeeCheckGross && scope.canSeeCheckNet && scope.canSeeTaxes;
    case "settlements": return Boolean(context.individualId || context.employeeId) && scope.canSeeMoney
      && scope.canSeeSettlements && scope.canSeeEmployeeDeals;
    default: return false;
  }
}

/** Apply the same policy before search, ordering, and pagination in PostgreSQL. */
export function documentSourceWhere(scope: AccessScope, params: unknown[]): string {
  if (!scope.canViewDocuments) return "FALSE";
  if (scope.role === "admin" && scope.full) return "TRUE";
  const parameter = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const kinds: string[] = [];
  if (scope.canSeeMoney && scope.canSeeClassFinancials) kinds.push("classes");
  if (scope.canPlan && scope.canSeeHours && scope.canSeeBudgets) kinds.push("planning");
  if (scope.canSeeMoney && scope.canSeeTransactions && scope.canSeeEmployeeAmounts && scope.canSeeCheckGross
    && scope.canSeeCheckNet && scope.canSeeTaxes) kinds.push("payroll");
  if (scope.canSeeMoney && scope.canSeeSettlements && scope.canSeeEmployeeDeals) kinds.push("settlements");
  const person = `(d.access_context->>'individualId' ~* '${SUBJECT_ID_PATTERN}' AND ${scope.allIndividuals ? "TRUE" : `d.access_context->>'individualId' = ANY(${parameter(scope.grantedIndividualIds)}::text[])`})`;
  const employee = `(d.access_context->>'employeeId' ~* '${SUBJECT_ID_PATTERN}' AND ${scope.allEmployees ? "TRUE" : `d.access_context->>'employeeId' = ANY(${parameter(scope.grantedEmployeeIds)}::text[])`})`;
  const classified = `(d.access_context->>'kind' = ANY(${parameter(kinds)}::text[])
    AND (NOT (d.access_context ? 'individualId') OR ${person})
    AND (NOT (d.access_context ? 'employeeId') OR ${employee})
    AND CASE d.access_context->>'kind'
      WHEN 'classes' THEN d.access_context ? 'individualId'
      WHEN 'planning' THEN d.access_context ? 'individualId'
      WHEN 'payroll' THEN d.access_context ? 'employeeId'
      WHEN 'settlements' THEN d.access_context ? 'individualId' OR d.access_context ? 'employeeId'
      ELSE FALSE END)`;
  return scope.canEditDocuments
    ? `(${classified} OR (d.access_context->>'kind' = 'private' AND d.created_by_user_id = ${parameter(scope.userId)}::uuid
        AND (NOT (d.access_context ? 'individualId') OR ${person})
        AND (NOT (d.access_context ? 'employeeId') OR ${employee})
        AND jsonb_typeof(d.access_context->'requiredCapabilities') = 'array'
        AND d.access_context->'requiredCapabilities' <@ ${parameter(JSON.stringify(DOCUMENT_VISIBILITY.filter((capability) => scope[capability])))}::jsonb))`
    : classified;
}

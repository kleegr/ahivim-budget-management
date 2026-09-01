import { MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS } from "@/lib/business/payroll-check-source";
import { validSettlementSourceKey } from "@/lib/business/settlement-source-key";

export type CollectionsView = "summary" | "targets" | "checks";

export interface PayrollCheckDraft {
  employeeId: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  sourceTransactionIds: string[];
}

type SearchValues = Record<string, string | string[] | undefined>;

interface PayrollCheckLinkSource {
  sourceId?: string;
  employeeId: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  transactionIds?: readonly string[];
}

interface CollectionsAccess {
  canOpenTargets: boolean;
  canOpenChecks: boolean;
  canCreateCheck: boolean;
  employeeIds: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPLICIT_SOURCE_IDS_IN_URL = 20;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function dateParam(value: string | string[] | undefined): string | null {
  const candidate = first(value);
  if (!candidate || !DATE.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate;
}

function checkNumberParam(value: string | string[] | undefined): string | null {
  const candidate = first(value)?.trim();
  return candidate && candidate.length <= 250 ? candidate : null;
}

function sourceTransactionIdsParam(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return [];
  const values = (Array.isArray(value) ? value : [value]).map((item) => item.trim());
  if (values.length > MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS
      || values.some((item) => !UUID.test(item))) return null;
  return [...new Set(values)];
}

export function collectionsSettlementSourceParam(search: SearchValues): string | null {
  const candidate = first(search.settlementSource);
  return candidate && validSettlementSourceKey(candidate) ? candidate : null;
}

export function collectionsPayrollCheckHref(source: PayrollCheckLinkSource): string | null {
  const params = new URLSearchParams({
    view: "checks",
    newCheck: "1",
    employeeId: source.employeeId,
  });
  if (source.checkNumber) params.set("checkNumber", source.checkNumber);
  if (source.checkDate) params.set("checkDate", source.checkDate);
  if (source.periodBegin) params.set("periodBegin", source.periodBegin);
  if (source.periodEnd) params.set("periodEnd", source.periodEnd);
  if ((source.transactionIds?.length ?? 0) > 1
      && source.sourceId
      && !UUID.test(source.sourceId)
      && validSettlementSourceKey(source.sourceId)) {
    params.set("settlementSource", source.sourceId);
  } else if ((source.transactionIds?.length ?? 0) <= MAX_EXPLICIT_SOURCE_IDS_IN_URL) {
    for (const id of source.transactionIds ?? []) params.append("sourceTransactionId", id);
  } else {
    return null;
  }
  return `/masser?${params.toString()}`;
}

export function collectionsPayrollCheckFocusHref(input: {
  payrollCheckId: string;
  month: string;
}): string {
  const params = new URLSearchParams({
    view: "checks",
    month: input.month,
    focusCheckId: input.payrollCheckId,
  });
  return `/masser?${params.toString()}`;
}

export function collectionsFocusedPayrollCheckId(search: SearchValues): string | null {
  const candidate = first(search.focusCheckId);
  return candidate && UUID.test(candidate) ? candidate : null;
}

/**
 * Resolve URL state only after the server has applied the user's visibility and
 * employee scope. This keeps a crafted query string from opening a sensitive
 * form or injecting an employee outside the permitted collection workspace.
 */
export function collectionsInitialState(
  search: SearchValues,
  access: CollectionsAccess,
  options: { resolvedSourceTransactionIds?: readonly string[] | null } = {},
): { view: CollectionsView; checkDraft: PayrollCheckDraft | null } {
  const requestedView = first(search.view);
  const view: CollectionsView = requestedView === "checks" && access.canOpenChecks
    ? "checks"
    : requestedView === "targets" && access.canOpenTargets
      ? "targets"
      : "summary";

  const employeeId = first(search.employeeId) ?? "";
  const resolvedSourceIds = options.resolvedSourceTransactionIds;
  const sourceTransactionIds = resolvedSourceIds === undefined
    ? sourceTransactionIdsParam(search.sourceTransactionId)
    : resolvedSourceIds === null
      || resolvedSourceIds.length > MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS
      || resolvedSourceIds.some((id) => !UUID.test(id))
      ? null
      : [...new Set(resolvedSourceIds)];
  const canPrefill = view === "checks"
    && first(search.newCheck) === "1"
    && access.canCreateCheck
    && UUID.test(employeeId)
    && access.employeeIds.includes(employeeId)
    && sourceTransactionIds !== null;

  return {
    view,
    checkDraft: canPrefill
      ? {
          employeeId,
          checkNumber: checkNumberParam(search.checkNumber),
          checkDate: dateParam(search.checkDate),
          periodBegin: dateParam(search.periodBegin),
          periodEnd: dateParam(search.periodEnd),
          sourceTransactionIds: sourceTransactionIds ?? [],
        }
      : null,
  };
}

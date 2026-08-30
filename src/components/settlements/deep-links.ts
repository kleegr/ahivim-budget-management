import type { FilterState } from "@/components/data-grid/types";
import { collectionsPayrollCheckHref } from "@/lib/nav/collections-links";
import { txLink } from "@/lib/nav/tx-link";

interface CheckIssueLinkSource {
  sourceId: string;
  transactionIds?: readonly string[];
  employeeId: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  transactionCount: number;
  issue?:
    | "missing_check_identity"
    | "missing_net"
    | "conflicting_net"
    | "conflicting_check_date"
    | "missing_base"
    | "unknown_recipient";
}

export interface SettlementCheckIssueAction {
  href: string;
  label: "Record verified check" | "Inspect source rows";
}

export type SettlementQueueFilter = "all" | "open" | "payable" | "receivable" | "reserve" | "credit" | "completed";
export type SettlementDeepLinkQueue = Exclude<SettlementQueueFilter, "all">;
export type SettlementDeepLinkFocus = "refresh" | "missing-deals" | "check-issues";

const QUEUES = new Set<SettlementDeepLinkQueue>([
  "open",
  "payable",
  "receivable",
  "reserve",
  "credit",
  "completed",
]);
const FOCUSES = new Set<SettlementDeepLinkFocus>([
  "refresh",
  "missing-deals",
  "check-issues",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function settlementQueueFromParam(value: string | null | undefined): SettlementDeepLinkQueue | null {
  return value && QUEUES.has(value as SettlementDeepLinkQueue)
    ? value as SettlementDeepLinkQueue
    : null;
}

export function settlementFocusFromParam(value: string | null | undefined): SettlementDeepLinkFocus | null {
  return value && FOCUSES.has(value as SettlementDeepLinkFocus)
    ? value as SettlementDeepLinkFocus
    : null;
}

export function settlementMissingDealsState(input: {
  focused: boolean;
  canSeeEmployeeDeals: boolean;
  missingDealCount: number;
}): "hidden" | "permission-limited" | "clear" | "issues" {
  if (input.focused && !input.canSeeEmployeeDeals) return "permission-limited";
  if (input.missingDealCount > 0) return "issues";
  return input.focused ? "clear" : "hidden";
}

export function settlementQueueFilters(queue: SettlementQueueFilter): FilterState {
  if (queue === "all") return {};
  if (queue === "payable" || queue === "receivable" || queue === "reserve") {
    return {
      direction: { selected: [queue] },
      state: { selected: ["open", "partial"] },
    };
  }
  if (queue === "credit") return { state: { selected: ["credit"] } };
  if (queue === "completed") return { state: { selected: ["settled"] } };
  return { state: { selected: ["open", "partial", "credit"] } };
}

export function settlementCheckIssueHref(issue: CheckIssueLinkSource): string {
  if (issue.transactionIds?.length) {
    return txLink({ transactionIds: issue.transactionIds });
  }
  if (issue.transactionCount === 1 && UUID.test(issue.sourceId)) {
    return txLink({ transactionId: issue.sourceId });
  }
  if (issue.checkNumber) {
    if (issue.issue === "conflicting_check_date") {
      return txLink({ employeeId: issue.employeeId, checkNumber: issue.checkNumber });
    }
    if (issue.checkDate) {
      return txLink({
        employeeId: issue.employeeId,
        checkNumber: issue.checkNumber,
        from: issue.checkDate,
        to: issue.checkDate,
      });
    }
    return txLink({
      employeeId: issue.employeeId,
      checkNumber: issue.checkNumber,
      pbFrom: issue.periodBegin,
      pbTo: issue.periodEnd,
    });
  }
  if (issue.periodBegin || issue.periodEnd) {
    return txLink({
      employeeId: issue.employeeId,
      pbFrom: issue.periodBegin,
      pbTo: issue.periodEnd,
    });
  }
  if (issue.checkDate) {
    return txLink({ employeeId: issue.employeeId, from: issue.checkDate, to: issue.checkDate });
  }
  return txLink({ employeeId: issue.employeeId });
}

export function settlementCheckIssueAction(
  issue: CheckIssueLinkSource & { issue: NonNullable<CheckIssueLinkSource["issue"]> },
  permissions: { canRecordPayrollCheck: boolean; canSeeTransactions: boolean },
): SettlementCheckIssueAction | null {
  const isPayrollCheckFact = issue.issue === "missing_check_identity"
    || issue.issue === "missing_net"
    || issue.issue === "conflicting_net"
    || issue.issue === "conflicting_check_date";

  const exactSourceRows = issue.transactionIds?.length === issue.transactionCount;
  const canResolveWithOneVerifiedCheck = issue.issue !== "conflicting_check_date";
  if (isPayrollCheckFact && exactSourceRows && canResolveWithOneVerifiedCheck && permissions.canRecordPayrollCheck) {
    return {
      href: collectionsPayrollCheckHref(issue),
      label: "Record verified check",
    };
  }
  if (permissions.canSeeTransactions) {
    return {
      href: settlementCheckIssueHref(issue),
      label: "Inspect source rows",
    };
  }
  return null;
}

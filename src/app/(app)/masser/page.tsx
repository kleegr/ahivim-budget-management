import { redirect } from "next/navigation";
import { isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import { requireUser } from "@/lib/auth/session";
import { getCollectionsWorkspace } from "@/lib/data/direct-pay-operations";
import { withDb } from "@/lib/data/pool";
import CollectionsWorkspace from "@/components/collections/collections-workspace";
import { ButtonLink, ErrorPanel, PageHeader } from "@/components/ui";
import { agencyMonth } from "@/lib/business/agency-time";
import {
  collectionsFocusedPayrollCheckId,
  collectionsInitialState,
  collectionsSettlementSourceParam,
} from "@/lib/nav/collections-links";
import { resolveSettlementSourceTransactions } from "@/lib/data/settlement-source-transactions";
import { MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS } from "@/lib/business/payroll-check-source";

export const dynamic = "force-dynamic";
export const metadata = { title: "Masser - Ahivim" };

export default async function MasserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const raw = await searchParams;
  const monthValue = Array.isArray(raw.month) ? raw.month[0] : raw.month;
  const month = monthValue ?? agencyMonth();
  const focusedCheckId = collectionsFocusedPayrollCheckId(raw);
  const requestedSettlementSource = collectionsSettlementSourceParam(raw);
  const hasSettlementSource = raw.settlementSource !== undefined;
  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    if (!scope.canSeeSettlements) {
      return {
        denied: true as const,
        planningOnly: isPlanningOnlyAccess(scope),
        data: null,
        canManage: false,
        canSeeEmployeeDeals: false,
        canManageEmployeeDeals: false,
        canSeeTransactions: false,
        canManageFinancialPlans: false,
        canRepairImports: false,
        sourceSelection: null,
      };
    }
    const [sourceSelection, data] = await Promise.all([
      requestedSettlementSource
        ? resolveSettlementSourceTransactions(pool, scope, requestedSettlementSource)
        : Promise.resolve(null),
      getCollectionsWorkspace(pool, scope, month, { payrollCheckId: focusedCheckId }),
    ]);
    return {
      denied: false as const,
      planningOnly: false,
      data,
      canManage: scope.canManageSettlements,
      canSeeEmployeeDeals: scope.canSeeEmployeeDeals,
      canManageEmployeeDeals: user.role !== "viewer" && scope.canSeeEmployeeDeals,
      canSeeTransactions: scope.canSeeTransactions,
      canManageFinancialPlans: user.role !== "viewer" && scope.full && scope.canSeeBudgets,
      canRepairImports: scope.canManageSettlements
        && scope.allEmployees
        && scope.allIndividuals
        && scope.canSeeCheckNet
        && scope.canSeeTaxes,
      sourceSelection,
    };
  });
  if (result.ok && result.data.planningOnly) redirect("/schedule");
  const resolvedSourceTransactionIds = hasSettlementSource
    ? requestedSettlementSource
      && result.ok
      && result.data.sourceSelection
      && !result.data.sourceSelection.tooLarge
      && result.data.sourceSelection.transactionIds.length > 0
      && result.data.sourceSelection.transactionIds.length <= MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS
      ? result.data.sourceSelection.transactionIds
      : null
    : undefined;
  const initialState = result.ok && result.data.data
    ? collectionsInitialState(raw, {
        canOpenTargets: result.data.data.visibility.canSeeTargetMoney
          || result.data.data.visibility.canSeeTargetHours,
        canOpenChecks: result.data.data.visibility.canSeeCheckNet
          || result.data.data.visibility.canSeeTaxes,
        canCreateCheck: result.data.canManage
          && result.data.data.visibility.canSeeCheckNet
          && result.data.data.visibility.canSeeTaxes,
        employeeIds: result.data.data.employees.map((employee) => employee.id),
      }, {
        resolvedSourceTransactionIds,
      })
    : null;
  const sourceUnavailable = hasSettlementSource
    && (!requestedSettlementSource
      || result.ok && (result.data.sourceSelection === null
        || result.data.sourceSelection.tooLarge
        || result.data.sourceSelection.transactionIds.length === 0
        || result.data.sourceSelection.transactionIds.length > MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS));
  const workspaceKey = initialState?.checkDraft
    ? [
        "check",
        initialState.checkDraft.employeeId,
        initialState.checkDraft.checkNumber ?? "no-number",
        initialState.checkDraft.checkDate ?? "no-check-date",
        initialState.checkDraft.periodBegin ?? "no-period-begin",
        initialState.checkDraft.periodEnd ?? "no-period-end",
        (requestedSettlementSource
          ?? initialState.checkDraft.sourceTransactionIds.join(","))
          || "manual",
      ].join(":")
    : initialState?.view ?? "summary";
  return (
    <>
      <PageHeader
        eyebrow="Masser"
        title="Collections & put-away"
        description="Collect what employees owe and prepare each individual's monthly set-aside update."
      />
      {!result.ok ? <ErrorPanel title="Could not load Masser">{result.error}</ErrorPanel>
        : result.data.denied || !result.data.data ? <ErrorPanel title="Masser is not included in this account" action={<ButtonLink href="/home">Back to home</ButtonLink>}>Ask an administrator to assign the Money collector role.</ErrorPanel>
        : <>
            {sourceUnavailable ? (
              <ErrorPanel
                title={result.data.sourceSelection
                  && (result.data.sourceSelection.tooLarge
                    || result.data.sourceSelection.transactionIds.length > MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS)
                  ? "This source has too many rows to record at once"
                  : "Source rows are no longer available"}
                action={<ButtonLink href="/settlements?focus=check-issues">Back to Money operations</ButtonLink>}
              >
                {result.data.sourceSelection
                  && (result.data.sourceSelection.tooLarge
                    || result.data.sourceSelection.transactionIds.length > MAX_PAYROLL_CHECK_SOURCE_TRANSACTIONS)
                  ? "Open the source rows from Money operations and narrow the item before recording a check."
                  : "Refresh Money operations to open the current payroll source again."}
              </ErrorPanel>
            ) : null}
            <CollectionsWorkspace
              key={workspaceKey}
              data={result.data.data}
              canManage={result.data.canManage}
              canSeeEmployeeDeals={result.data.canSeeEmployeeDeals}
              canManageEmployeeDeals={result.data.canManageEmployeeDeals}
              canSeeTransactions={result.data.canSeeTransactions}
              canManageFinancialPlans={result.data.canManageFinancialPlans}
              canRepairImports={result.data.canRepairImports}
              initialView={initialState?.view}
              initialCheckDraft={initialState?.checkDraft}
              focusedCheckId={result.data.data.payrollChecks.some((check) => check.id === focusedCheckId)
                ? focusedCheckId
                : null}
            />
          </>}
    </>
  );
}

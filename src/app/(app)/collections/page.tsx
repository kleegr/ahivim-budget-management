import { redirect } from "next/navigation";
import { isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import { requireUser } from "@/lib/auth/session";
import { getCollectionsWorkspace } from "@/lib/data/direct-pay-operations";
import { withDb } from "@/lib/data/pool";
import CollectionsWorkspace from "@/components/collections/collections-workspace";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { agencyMonth } from "@/lib/business/agency-time";
import { collectionsInitialState } from "@/lib/nav/collections-links";

export const dynamic = "force-dynamic";
export const metadata = { title: "Collections - Ahivim Budget Management" };

export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const raw = await searchParams;
  const monthValue = Array.isArray(raw.month) ? raw.month[0] : raw.month;
  const month = monthValue ?? agencyMonth();
  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    if (!scope.canSeeSettlements) return { denied: true as const, planningOnly: isPlanningOnlyAccess(scope), data: null, canManage: false };
    return {
      denied: false as const,
      planningOnly: false,
      data: await getCollectionsWorkspace(pool, scope, month),
      canManage: scope.canManageSettlements,
    };
  });
  if (result.ok && result.data.planningOnly) redirect("/schedule");
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
      })
    : null;
  const workspaceKey = initialState?.checkDraft
    ? [
        "check",
        initialState.checkDraft.employeeId,
        initialState.checkDraft.checkNumber ?? "no-number",
        initialState.checkDraft.checkDate ?? "no-check-date",
        initialState.checkDraft.periodBegin ?? "no-period-begin",
        initialState.checkDraft.periodEnd ?? "no-period-end",
        initialState.checkDraft.sourceTransactionIds.join(",") || "manual",
      ].join(":")
    : initialState?.view ?? "summary";
  return (
    <>
      <PageHeader eyebrow="Finance" title="Collections" description="Monthly employee give-backs, individual set-asides, gross targets, and payroll-check facts." />
      {!result.ok ? <ErrorPanel title="Could not load collections">{result.error}</ErrorPanel>
        : result.data.denied || !result.data.data ? <ErrorPanel title="No access to Collections">Your account does not include collection balances.</ErrorPanel>
        : <CollectionsWorkspace
            key={workspaceKey}
            data={result.data.data}
            canManage={result.data.canManage}
            initialView={initialState?.view}
            initialCheckDraft={initialState?.checkDraft}
          />}
    </>
  );
}

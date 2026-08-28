import { redirect } from "next/navigation";
import { isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import { requireUser } from "@/lib/auth/session";
import { getCollectionsWorkspace } from "@/lib/data/direct-pay-operations";
import { withDb } from "@/lib/data/pool";
import CollectionsWorkspace from "@/components/collections/collections-workspace";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { agencyMonth } from "@/lib/business/agency-time";

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
  return (
    <>
      <PageHeader eyebrow="Finance" title="Collections" description="Monthly employee give-backs, individual set-asides, gross targets, and payroll-check facts." />
      {!result.ok ? <ErrorPanel title="Could not load collections">{result.error}</ErrorPanel>
        : result.data.denied || !result.data.data ? <ErrorPanel title="No access to Collections">Your account does not include collection balances.</ErrorPanel>
        : <CollectionsWorkspace data={result.data.data} canManage={result.data.canManage} />}
    </>
  );
}

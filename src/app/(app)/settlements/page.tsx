import SettlementDashboard from "@/components/settlements/settlement-dashboard";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { resolveAccessScope } from "@/lib/auth/access";
import { requireUser } from "@/lib/auth/session";
import { getSettlementDashboard } from "@/lib/data/settlements";
import { withDb } from "@/lib/data/pool";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settlements - Ahivim Budget Management" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SettlementsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";
  const params = await searchParams;
  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    if (!scope.canSeeSettlements) return { denied: true as const, data: null };
    return { denied: false as const, data: await getSettlementDashboard(pool, scope) };
  });

  const requestedEmployeeId = first(params.employeeId);
  const requestedIndividualId = first(params.individualId);
  const requestedPersonId = requestedEmployeeId ?? requestedIndividualId;
  const requestedPersonType = requestedEmployeeId ? "employee" : requestedIndividualId ? "individual" : null;
  const initialPersonName = result.ok && result.data.data && requestedPersonId
    ? result.data.data.rows.find((row) => row.personId === requestedPersonId && row.personType === requestedPersonType)?.personName
      ?? result.data.data.events.find((event) => event.personId === requestedPersonId && event.personType === requestedPersonType)?.personName
      ?? (requestedPersonType === "employee"
        ? result.data.data.missingDeals.find((employee) => employee.employeeId === requestedPersonId)?.employeeName
          ?? result.data.data.checkIssues.find((issue) => issue.employeeId === requestedPersonId)?.employeeName
        : null)
      ?? null
    : null;

  return (
    <>
      <PageHeader
        eyebrow="Money control"
        title="Settlements"
        description="Exact balances for employee payouts, employee give-backs, and individual set-asides."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load settlements">{result.error}</ErrorPanel>
      ) : result.data.denied ? (
        <ErrorPanel title="No access to Settlements">
          Your account doesn&rsquo;t include permission to view settlement balances. Ask an administrator if you need it.
        </ErrorPanel>
      ) : (
        <SettlementDashboard
          key={requestedPersonId && requestedPersonType ? `${requestedPersonType}:${requestedPersonId}` : "all"}
          data={result.data.data}
          canManage={canManage}
          initialPersonName={initialPersonName}
          initialPersonId={requestedPersonId}
          initialPersonType={requestedPersonType}
        />
      )}
    </>
  );
}

import { requireUser, roleAtLeast } from "@/lib/auth/session";
import { canAccessPlanning, isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import AppNav from "@/components/app-nav";
import { withDb } from "@/lib/data/pool";
import { exceptionCounts } from "@/lib/data/queries";
import { agencyIdsWithPlanningAccess, hasPortalCapability, resolvePortalAccess } from "@/lib/auth/portal-access";

export const dynamic = "force-dynamic";

/**
 * Every screen inside this group is behind this one check. Middleware only
 * redirects on a missing cookie; this is where the signature is verified and
 * the account is re-read from the database.
 *
 * We also compute the total "Review" backlog here so the nav can wear a live
 * count badge and the user is pulled to it only when there is work to do.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("viewer");
  const isManager = roleAtLeast(user.role, "manager");

  // The Review inbox rolls up every "needs a human" category into one number.
  // Failing quietly is the right choice: a broken count must never break the
  // whole layout — the user still has to be able to navigate.
  // The badge counts DECISIONS a person must make — a name that is ambiguous, a
  // possible duplicate person to merge, an alias to approve, an unmapped program,
  // or an import that did not reconcile. Monitoring metrics that need no decision
  // (rate exceptions, possible-duplicate rows that already imported, group-session
  // grouping, over-budget individuals) are shown on their own screens, not counted
  // here — so the badge means "there is something for you to resolve", not noise.
  // We also read the user's access scope so the nav only exposes destinations
  // after their capabilities have been resolved successfully.
  let reviewCount = 0;
  let accessResolved = false;
  let canSeeTransactions = false;
  let canSeeSettlements = false;
  let canSeeBudgets = false;
  let canPlan = false;
  let canSeeClassFinancials = false;
  let canSeeEmployees = false;
  let canEditDocuments = false;
  let canUsePortal = false;
  let canManageAgencies = false;
  const accessPromise = withDb(async (pool) => {
    const [scope, portal] = await Promise.all([
      resolveAccessScope(pool, user),
      resolvePortalAccess(pool, user),
    ]);
    const internalPlanning = canAccessPlanning(scope);
    const agencyPlanning = !internalPlanning
      && agencyIdsWithPlanningAccess(portal).length > 0;
    return {
      canSeeTransactions: scope.canSeeTransactions,
      canSeeSettlements: scope.canSeeSettlements,
      canSeeBudgets: scope.canSeeBudgets,
      canPlan: internalPlanning || agencyPlanning,
      canSeeClassFinancials: scope.canSeeClassFinancials,
      canSeeEmployees:
        !isPlanningOnlyAccess(scope)
        && (scope.full || scope.allEmployees || scope.employeeIds.length > 0),
      canEditDocuments: scope.canEditDocuments,
      canUsePortal:
        portal.globalRoles.length > 0
        || portal.agencyAccess.length > 0
        || portal.individualLinks.length > 0
        || portal.employeeLinks.length > 0,
      canManageAgencies: hasPortalCapability(portal, "agencies.manage"),
    };
  });
  const countsPromise = isManager
    ? withDb((pool) => exceptionCounts(pool, { includeOverAuthorization: false }))
    : null;
  const [access, counts] = await Promise.all([accessPromise, countsPromise]);
  if (access.ok) {
    accessResolved = true;
    canSeeTransactions = access.data.canSeeTransactions;
    canSeeSettlements = access.data.canSeeSettlements;
    canSeeBudgets = access.data.canSeeBudgets;
    canPlan = access.data.canPlan;
    canSeeClassFinancials = access.data.canSeeClassFinancials;
    canSeeEmployees = access.data.canSeeEmployees;
    canEditDocuments = access.data.canEditDocuments;
    canUsePortal = access.data.canUsePortal;
    canManageAgencies = access.data.canManageAgencies;
  }

  // Badge availability must not affect authorization. If this query fails, the
  // user keeps their successfully resolved navigation with an empty badge.
  if (counts?.ok) {
    const c = counts.data;
    reviewCount =
      c.unmatchedNames +
      c.duplicateIndividuals +
      c.pendingAliases +
      c.unknownPrograms +
      c.reconciliationDifferences;
  }

  return (
    <div className="min-h-screen bg-[var(--color-paper)] md:flex">
      <AppNav
        user={user}
        reviewCount={reviewCount}
        accessResolved={accessResolved}
        canSeeTransactions={canSeeTransactions}
        canSeeSettlements={canSeeSettlements}
        canSeeBudgets={canSeeBudgets}
        canPlan={canPlan}
        canSeeClassFinancials={canSeeClassFinancials}
        canSeeEmployees={canSeeEmployees}
        canEditDocuments={canEditDocuments}
        canUsePortal={canUsePortal}
        canManageAgencies={canManageAgencies}
      />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <main id="main" className="mx-auto w-full max-w-[100rem] flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-[100rem] px-4 pb-8 text-xs text-[var(--color-ink-faint)] sm:px-6 lg:px-8">
          Ahivim Budget Management
        </footer>
      </div>
    </div>
  );
}

import { requireUser } from "@/lib/auth/session";
import { canAccessPlanning, isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import AppNav from "@/components/app-nav";
import { withDb } from "@/lib/data/pool";
import { agencyIdsWithPlanningAccess, hasPortalCapability, resolvePortalAccess } from "@/lib/auth/portal-access";

export const dynamic = "force-dynamic";

/**
 * Every screen inside this group is behind this one check. Middleware only
 * redirects on a missing cookie; this is where the signature is verified and
 * the account is re-read from the database.
 *
 * The shared layout resolves capabilities once so every person sees only the
 * few destinations that belong to their job.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("viewer");
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
  const access = await withDb(async (pool) => {
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

  return (
    <div className="min-h-screen bg-[var(--color-paper)] md:flex">
      <AppNav
        user={user}
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

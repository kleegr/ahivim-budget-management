import { currentImpersonation, requireUser } from "@/lib/auth/session";
import { canAccessPlanning, isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import AppNav from "@/components/app-nav";
import { withDb } from "@/lib/data/pool";
import { agencyIdsWithPlanningAccess, hasPortalCapability, resolvePortalAccess } from "@/lib/auth/portal-access";
import ImpersonationBar from "@/components/auth/impersonation-bar";
import { resolveAccountProfile } from "@/lib/auth/account-label";
import AccessNotice from "@/components/auth/access-notice";

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
  const impersonation = await currentImpersonation();
  let accessResolved = false;
  let canSeeTransactions = false;
  let canSeeSettlements = false;
  let canSeeBudgets = false;
  let canPlan = false;
  let canSeeClassFinancials = false;
  let canSeeEmployees = false;
  let canViewDocuments = false;
  let canUsePortal = false;
  let canManageAgencies = false;
  let accountLabel = resolveAccountProfile(user.role, null, null, user.accountPreset).label;
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
        internalPlanning
        || (!isPlanningOnlyAccess(scope)
          && (scope.full || scope.allEmployees || scope.employeeIds.length > 0)),
      canViewDocuments: scope.canViewDocuments,
      canUsePortal:
        portal.globalRoles.length > 0
        || portal.agencyAccess.length > 0
        || portal.individualLinks.length > 0
        || portal.employeeLinks.length > 0,
      canManageAgencies: hasPortalCapability(portal, "agencies.manage"),
      accountLabel: resolveAccountProfile(user.role, scope, portal, user.accountPreset).label,
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
    canViewDocuments = access.data.canViewDocuments;
    canUsePortal = access.data.canUsePortal;
    canManageAgencies = access.data.canManageAgencies;
    accountLabel = access.data.accountLabel;
  }

  return (
    <div className={`${impersonation ? "[--impersonation-bar-height:2.75rem]" : "[--impersonation-bar-height:0px]"} [--shell-header-height:calc(var(--impersonation-bar-height)+4rem)] md:[--shell-header-height:var(--impersonation-bar-height)]`}>
      {impersonation ? <ImpersonationBar impersonation={impersonation} accountLabel={accountLabel} /> : null}
      <div className="min-h-[calc(100vh-var(--impersonation-bar-height))] bg-[var(--color-paper)] md:flex">
        <AppNav
          user={user}
          accountLabel={accountLabel}
          accessResolved={accessResolved}
          canSeeTransactions={canSeeTransactions}
          canSeeSettlements={canSeeSettlements}
          canSeeBudgets={canSeeBudgets}
          canPlan={canPlan}
          canSeeClassFinancials={canSeeClassFinancials}
          canSeeEmployees={canSeeEmployees}
          canViewDocuments={canViewDocuments}
          canUsePortal={canUsePortal}
          canManageAgencies={canManageAgencies}
        />
        <div className="flex min-h-[calc(100vh-var(--impersonation-bar-height))] min-w-0 flex-1 flex-col">
          <main id="main" className="mx-auto w-full max-w-[100rem] flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            <AccessNotice />
            {children}
          </main>
          <footer className="mx-auto w-full max-w-[100rem] px-4 pb-8 text-xs text-[var(--color-ink-faint)] sm:px-6 lg:px-8">
            Ahivim Budget Management
          </footer>
        </div>
      </div>
    </div>
  );
}

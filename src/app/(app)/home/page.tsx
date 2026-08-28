import { redirect } from "next/navigation";
import { currentUser, roleAtLeast } from "@/lib/auth/session";
import { canAccessPlanning, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { resolvePortalAccess } from "@/lib/auth/portal-access";

export const dynamic = "force-dynamic";

/**
 * `/home` is the canonical landing route. Managers and admins land on the
 * dashboard overview. A viewer lands on the first workspace their configured
 * access actually permits, so a finance-only account opens Money operations
 * without passing through a budget screen.
 */
export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect("/signin");
  if (roleAtLeast(user.role, "manager")) redirect("/dashboard");

  const resolved = await withDb(async (pool) => {
    const [access, portal] = await Promise.all([
      resolveAccessScope(pool, user),
      resolvePortalAccess(pool, user),
    ]);
    return { access, portal };
  });
  if (resolved.ok) {
    const { access, portal } = resolved.data;
    const agencyRoles = new Set(portal.agencyAccess.map((assignment) => assignment.role));
    if (canAccessPlanning(access)) redirect("/schedule");
    if (access.canSeeSettlements && agencyRoles.has("collector")) redirect("/collections");
    const externalPortal = portal.globalRoles.some((assignment) => assignment.role !== "owner")
      || portal.agencyAccess.length > 0
      || portal.individualLinks.length > 0
      || portal.employeeLinks.length > 0;
    if (externalPortal) redirect("/portal");
    if (access.canSeeBudgets) redirect("/individuals");
    if (access.canSeeSettlements) redirect("/collections");
    if (access.canSeeTransactions) redirect("/transactions");
  }
  redirect("/employees");
}

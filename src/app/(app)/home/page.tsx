import { redirect } from "next/navigation";
import { currentUser, roleAtLeast } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";

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

  const access = await withDb((pool) => resolveAccessScope(pool, user));
  if (access.ok) {
    if (access.data.canSeeBudgets) redirect("/individuals");
    if (access.data.canSeeSettlements) redirect("/settlements");
    if (access.data.canSeeTransactions) redirect("/transactions");
  }
  redirect("/employees");
}

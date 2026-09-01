import { redirect } from "next/navigation";
import { currentUser, roleAtLeast } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { resolvePortalAccess } from "@/lib/auth/portal-access";
import { viewerHomePath, withDeniedNotice } from "@/lib/nav/home-route";

export const dynamic = "force-dynamic";

/**
 * `/home` is the canonical landing route. Managers and admins land on the
 * dashboard overview. A viewer lands on the first workspace their configured
 * access actually permits, so a finance-only account opens Money operations
 * without passing through a budget screen.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const denied = params.denied === "1";
  const user = await currentUser();
  if (!user) redirect("/signin");
  if (roleAtLeast(user.role, "manager")) redirect(withDeniedNotice("/dashboard", denied));

  const resolved = await withDb(async (pool) => {
    const [access, portal] = await Promise.all([
      resolveAccessScope(pool, user),
      resolvePortalAccess(pool, user),
    ]);
    return { access, portal };
  });
  if (resolved.ok) {
    const { access, portal } = resolved.data;
    redirect(withDeniedNotice(viewerHomePath(access, portal), denied));
  }
  redirect(withDeniedNotice("/settings", denied));
}

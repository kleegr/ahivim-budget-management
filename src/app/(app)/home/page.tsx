import { redirect } from "next/navigation";
import { currentUser, homePathForRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * `/home` is the canonical landing route. Managers and admins land on the
 * dashboard overview; a viewer (who can't see the portfolio dashboard) lands on
 * their Individuals list instead. Keeps the URL friendly without forking render.
 */
export default async function HomePage() {
  const user = await currentUser();
  redirect(homePathForRole(user?.role));
}

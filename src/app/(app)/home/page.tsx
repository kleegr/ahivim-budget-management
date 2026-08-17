import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * `/home` is the canonical landing route. The existing dashboard renderer at
 * `/dashboard` still holds all the summary data; a light redirect keeps the
 * URL friendly ("Home", not "Dashboard") without forking the render code.
 * The dashboard itself is being redesigned to lead with "what needs you" —
 * that lives in `/dashboard/page.tsx`.
 */
export default function HomePage() {
  redirect("/dashboard");
}

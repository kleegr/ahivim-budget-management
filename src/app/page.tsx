import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Home is the canonical entry point. It dispatches each authenticated person
 * to the owner overview or the first workspace their role can actually use.
 * Middleware handles anonymity.
 */
export default function RootPage() {
  redirect("/home");
}

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "People — Ahivim Budget Management" };

/**
 * The old "People" hub is gone: Individuals and Employees are now top-level
 * workspaces of their own, so this route just forwards to Individuals rather than
 * making the user pick a side first.
 */
export default function PeoplePage() {
  redirect("/individuals");
}

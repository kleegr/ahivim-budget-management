import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projections — Ahivim Budget Management" };

/**
 * "Projections" is the product name for the forward-looking budget engine that
 * currently lives at /calculations. This alias makes the new name a real URL
 * while the underlying route is migrated in a later phase. Fully reversible.
 */
export default function ProjectionsPage() {
  redirect("/calculations");
}

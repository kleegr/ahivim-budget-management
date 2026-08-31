import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Financial setup - Ahivim Budget Management" };

/** Kept as a compatibility route for saved links to the old duplicate board. */
export default async function MasserPage() {
  await requireUser("manager");
  redirect("/calculations");
}

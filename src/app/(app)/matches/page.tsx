import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listMatchReviews } from "@/lib/manage/individual-merge";
import { PageHeader, ErrorPanel } from "@/components/ui";
import MatchesClient from "@/components/matches/matches-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Name matches — Ahivim Budget Management" };

export default async function MatchesPage() {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";
  const result = await withDb((pool) => listMatchReviews(pool, { status: "pending" }));

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Name matches"
        description="Where the Calculations and Transactions tabs spelled a name differently, obvious variants are connected automatically. Anything uncertain waits here for you to confirm — so two records for one person become one, and nobody is merged by mistake."
      />
      {!result.ok ? (
        <ErrorPanel title="Could not load matches">{result.error}</ErrorPanel>
      ) : (
        <MatchesClient reviews={result.data} canManage={canManage} />
      )}
    </>
  );
}

import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getFinancialDashboard } from "@/lib/data/financial-dashboard";
import { PageHeader, ErrorPanel } from "@/components/ui";
import MasserDashboard from "@/components/financial/masser-dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Masser — Ahivim Budget Management" };

/**
 * The Masser board — the money side across the whole roster, one row per
 * individual. It answers the questions the Google sheet's summary tab did: how
 * much we set aside (Masser), how much the employees made, how much the agency
 * made, the total between them, and the tax reserve — with a phone, an account
 * tag and free notes editable right on each row. Managers only (the money side).
 */
export default async function MasserPage() {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";

  const result = await withDb((pool) => getFinancialDashboard(pool));

  return (
    <>
      <PageHeader
        eyebrow="Financial · the money board"
        title="Masser"
        description="Every individual on one board: how much to put away (Masser), what the employees made, what the agency made, the total between them, and the tax reserve. Money splits cleanly — what the employees made plus what the agency made equals the total billed. Toggle between this budget year and all-time, and keep a phone, an account tag and notes on each person."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load the Masser board">{result.error}</ErrorPanel>
      ) : (
        <MasserDashboard data={result.data} canManage={canManage} />
      )}
    </>
  );
}

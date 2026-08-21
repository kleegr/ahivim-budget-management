import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getMasserSheet } from "@/lib/data/masser-sheet";
import { PageHeader, ErrorPanel } from "@/components/ui";
import MasserDashboard from "@/components/financial/masser-dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Masser — Ahivim Budget Management" };

/**
 * The Masser board — the cuts / calculation sheet across the whole budgeted
 * roster, one row per plan: the two cuts, the clock and other adjustments, the
 * authorized hours per program (the budget), then yearly gross → monthly gross →
 * gross net → net, and Masser (the "After All" set-aside). Columns show / hide /
 * reorder; account, phone and notes edit inline. Managers only.
 */
export default async function MasserPage() {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";

  const result = await withDb((pool) => getMasserSheet(pool));

  return (
    <>
      <PageHeader
        eyebrow="Financial · the cuts sheet"
        title="Masser"
        description="Every plan on one sheet: the first and second cuts, the clock and other adjustments, the authorized hours per program, then yearly gross, monthly gross, gross net and net — and Masser, the fixed set-aside. Show, hide and reorder columns to your taste; the footer totals every money column."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load the Masser board">{result.error}</ErrorPanel>
      ) : (
        <MasserDashboard data={result.data} canManage={canManage} />
      )}
    </>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { PageHeader, ErrorPanel } from "@/components/ui";
import CalculationsGrid from "@/components/calculations/calculations-grid";

export const dynamic = "force-dynamic";
export const metadata = { title: "Financial — Ahivim Budget Management" };

/**
 * Financial (the Calculations workbook). This is the money side — internal
 * rates, the two sequential cuts, adjustments and the net "after all" figure per
 * account — kept deliberately distinct from Budget (authorized hours vs billed),
 * which lives on each individual. The grid opens on a risk-first "Glance" view
 * and a "Full sheet" toggle for the complete editable grid.
 */
export default async function ProjectionsPage({ searchParams }: { searchParams: Promise<{ individualId?: string }> }) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";
  const { individualId } = await searchParams;

  const result = await withDb(async (pool) => {
    const strategies = await listStrategies(pool, { withAnalytics: true });
    const individuals = (await listIndividualsManaged(pool, { status: "active" })).map((i) => ({
      id: i.id,
      name: i.displayName,
    }));
    return { strategies, individuals };
  });

  // When opened from an individual (e.g. "Adjust cuts"), focus the sheet on that
  // person instead of the whole roster.
  const focusRows = result.ok && individualId ? result.data.strategies.rows.filter((r) => r.individualId === individualId) : null;
  const focusName = focusRows && focusRows.length > 0 ? focusRows[0].individualName : null;

  return (
    <>
      <PageHeader
        eyebrow="Financial · the money side"
        title="Financial"
        description="The Calculations workbook: internal rates, the first and second cuts, adjustments, and each account's net “after all” figure. This is the money model — distinct from Budget (authorized vs billed hours), which lives on each individual. Glance sorts the accounts that need action to the top; Full sheet edits hours and cuts inline, every figure explained."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load projections">{result.error}</ErrorPanel>
      ) : (
        <>
          {individualId ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm">
              <span className="text-[var(--color-ink-soft)]">
                Showing <span className="font-medium text-[var(--color-ink)]">{focusName ?? "one individual"}</span> only.
              </span>
              <Link href="/calculations" className="text-[var(--color-primary)] hover:underline">Show all accounts →</Link>
            </div>
          ) : null}
          <CalculationsGrid
            rows={focusRows ?? result.data.strategies.rows}
            programs={result.data.strategies.programs}
            individuals={result.data.individuals}
            canManage={canManage}
          />
        </>
      )}
    </>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { PageHeader, ErrorPanel } from "@/components/ui";
import CalculationsGrid from "@/components/calculations/calculations-grid";

export const dynamic = "force-dynamic";
export const metadata = { title: "Financial setup - Ahivim" };

/**
 * Financial setup (the Calculations workbook). This is the standing money setup:
 * internal rates, two sequential cuts, adjustments, and the approved monthly
 * final per account. Actual transactions and budget utilization live elsewhere.
 */
export default async function FinancialSetupPage({ searchParams }: { searchParams: Promise<{ individualId?: string }> }) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";
  const { individualId } = await searchParams;

  const result = await withDb(async (pool) => {
    const [strategies, managedIndividuals] = await Promise.all([
      listStrategies(pool, { withAnalytics: true }),
      listIndividualsManaged(pool, { status: "active" }),
    ]);
    const individuals = managedIndividuals.map((i) => ({
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
        eyebrow="Financial"
        title="Financial setup"
        description="Review each account's expected monthly amount, sequential cuts, and approved final."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load financial setup">{result.error}</ErrorPanel>
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

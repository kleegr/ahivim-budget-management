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
export default async function ProjectionsPage() {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";

  const result = await withDb(async (pool) => {
    const strategies = await listStrategies(pool, { withAnalytics: true });
    const individuals = (await listIndividualsManaged(pool, { status: "active" })).map((i) => ({
      id: i.id,
      name: i.displayName,
    }));
    return { strategies, individuals };
  });

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
        <CalculationsGrid
          rows={result.data.strategies.rows}
          programs={result.data.strategies.programs}
          individuals={result.data.individuals}
          canManage={canManage}
        />
      )}
    </>
  );
}

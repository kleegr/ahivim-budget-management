import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { PageHeader, ErrorPanel } from "@/components/ui";
import CalculationsGrid from "@/components/calculations/calculations-grid";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projections — Ahivim Budget Management" };

/**
 * Projections. The grid itself opens on a risk-first "Glance" view (status
 * tiles + a pace bar and badge on every row) and a "Full sheet" toggle for the
 * complete editable grid, so the page no longer needs a separate summary band
 * above it — that was the same information twice.
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
        eyebrow="Projections"
        title="Projections"
        description="Every person's budget on one screen. The Glance view sorts the ones that need action to the top; switch to the Full sheet to edit hours and cuts inline, with every figure explained step by step."
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

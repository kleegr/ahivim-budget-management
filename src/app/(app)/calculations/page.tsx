import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { PageHeader, ErrorPanel } from "@/components/ui";
import CalculationsGrid from "@/components/calculations/calculations-grid";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calculations — Ahivim Budget Management" };

export default async function CalculationsPage() {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";

  const result = await withDb(async (pool) => {
    const strategies = await listStrategies(pool, {});
    const individuals = (await listIndividualsManaged(pool, { status: "active" })).map((i) => ({
      id: i.id,
      name: i.displayName,
    }));
    return { strategies, individuals };
  });

  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title="Calculations"
        description="Every budget strategy in one editable grid — like the Calculations workbook tab. Enter only the renewal date; the 12-month period is derived. Edit hours and cuts inline and every figure is explained step by step."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load calculations">{result.error}</ErrorPanel>
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

import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listPrograms } from "@/lib/data/app-queries";
import { listCalculations } from "@/lib/manage/calculations";
import { PageHeader, Card, EmptyState, ErrorPanel } from "@/components/ui";
import CalcWorkspace from "@/components/calculations/calc-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calculation — Ahivim Budget Management" };

export default async function CalculationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const individualId = one(sp.individualId) ?? "";

  const result = await withDb(async (pool) => ({
    individuals: (await listIndividualsManaged(pool, { status: "active" })).map((i) => ({
      id: i.id,
      displayName: i.displayName,
    })),
    programs: (await listPrograms(pool)).map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      agencyRate: p.agencyRate,
      internalRate: p.internalRate,
    })),
    calculations: individualId
      ? await listCalculations(pool, individualId)
      : { active: [], history: [] },
  }));

  const selectedName = result.ok
    ? result.data.individuals.find((i) => i.id === individualId)?.displayName ?? ""
    : "";

  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title="Calculation"
        description="Budgets, monthly allocation and the cut sequence — every figure shown step by step, so a number can always be explained rather than taken on faith."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load calculation data">{result.error}</ErrorPanel>
      ) : (
        <div className="space-y-4">
          <form
            method="get"
            className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 text-sm"
          >
            <label className="block">
              <span className="eyebrow">Individual</span>
              <select
                name="individualId"
                defaultValue={individualId}
                className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm"
              >
                <option value="">Choose an individual…</option>
                {result.data.individuals.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Open
            </button>
          </form>

          {individualId ? (
            <CalcWorkspace
              canManage={canManage}
              individualId={individualId}
              individualName={selectedName || "this individual"}
              programs={result.data.programs}
              active={result.data.calculations.active}
              history={result.data.calculations.history}
            />
          ) : (
            <Card>
              <EmptyState title="Pick an individual to begin">
                Choose someone above to build a live, step-by-step calculation and save it as a
                revision.
              </EmptyState>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

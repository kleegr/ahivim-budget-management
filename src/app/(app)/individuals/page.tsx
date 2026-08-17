import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listStrategies, type StrategyGridRow } from "@/lib/manage/calculation-strategies";
import { Card, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import { dec } from "@/lib/money";
import type { UtilizationStatus } from "@/lib/business/utilization";
import IndividualsList, { type IndividualRow, type IndividualBudget } from "@/components/individuals/individuals-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individuals — Ahivim Budget Management" };

/** The create/edit form shares one field set. */
function individualFields() {
  return (
    <>
      <Field label="Display name" name="displayName" required help="How this person is shown everywhere." />
      <Field label="Legal name" name="legalName" help="Defaults to the display name if left blank." />
      <Field label="Preferred name" name="preferredName" />
      <Field label="External reference" name="externalRef" help="An agency or case number, if there is one." />
      <TextAreaField label="Notes" name="notes" />
    </>
  );
}

const SEVERITY: Record<UtilizationStatus, number> = {
  over_authorization: 0,
  fully_used: 1,
  near_exhaustion: 2,
  behind_pace: 3,
  ahead_of_pace: 4,
  on_pace: 5,
  not_started: 6,
};

/**
 * Roll a person's one or more active plans into a single budget-health summary:
 * the worst pace status floats up, hours aggregate, and the earliest renewal is
 * the one to watch. This reuses the exact same analytics the Projections screen
 * uses (no new query, no new maths).
 */
function summarizeBudget(list: StrategyGridRow[], programCode: Map<string, string>): { budget: IndividualBudget | null; programs: string[] } {
  if (list.length === 0) return { budget: null, programs: [] };

  const programs = new Set<string>();
  let planned = dec(0);
  let actual = dec(0);
  let remaining = dec(0);
  let worst: { status: UtilizationStatus; elapsed: string | null } | null = null;
  let renews: string | null = null;

  for (const s of list) {
    for (const [pid, hrs] of Object.entries(s.hours)) {
      if (hrs && dec(hrs).greaterThan(0)) {
        const code = programCode.get(pid);
        if (code) programs.add(code);
      }
    }
    const a = s.analytics;
    if (a) {
      planned = planned.plus(dec(a.plannedHours || 0));
      actual = actual.plus(dec(a.actualHours || 0));
      remaining = remaining.plus(dec(a.remainingHours || 0));
      if (!worst || SEVERITY[a.status] < SEVERITY[worst.status]) {
        worst = { status: a.status, elapsed: a.timeElapsedPercent };
      }
    }
    if (s.renewalDate && (renews === null || s.renewalDate < renews)) renews = s.renewalDate;
  }

  const usedPct = planned.greaterThan(0) ? actual.dividedBy(planned).times(100).toNumber() : null;
  const elapsedPct = worst?.elapsed ? dec(worst.elapsed).times(100).toNumber() : null;

  return {
    budget: {
      status: worst?.status ?? "not_started",
      usedPct,
      elapsedPct,
      renews,
      hoursLeft: remaining.toNumber(),
      plans: list.length,
    },
    programs: [...programs].sort(),
  };
}

export default async function IndividualsPage() {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";

  const result = await withDb(async (pool) => {
    const individuals = await listIndividualsManaged(pool, { includeArchived: true });
    const strategies = await listStrategies(pool, { withAnalytics: true });
    return { individuals, strategies };
  });

  return (
    <>
      <PageHeader
        eyebrow="Register"
        title="Individuals"
        description="Everyone with authorized services, with each person's budget health at a glance. Search or sort live, and open a record to manage budgets, authorizations and assignments."
        action={
          canEdit ? (
            <CreateButton label="New individual" title="New individual" endpoint="/api/individuals" fields={individualFields()} />
          ) : undefined
        }
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load individuals">{result.error}</ErrorPanel>
      ) : result.data.individuals.length === 0 ? (
        <Card>
          <EmptyState title="No individuals yet">
            <p>Individuals appear here once a workbook is committed{canEdit ? ", or add one with the New individual button." : "."}</p>
          </EmptyState>
        </Card>
      ) : (
        (() => {
          const programCode = new Map(result.data.strategies.programs.map((p) => [p.id, p.code]));
          const byIndividual = new Map<string, StrategyGridRow[]>();
          for (const s of result.data.strategies.rows) {
            const arr = byIndividual.get(s.individualId) ?? [];
            arr.push(s);
            byIndividual.set(s.individualId, arr);
          }
          const rows: IndividualRow[] = result.data.individuals.map((ind) => {
            const { budget, programs } = summarizeBudget(byIndividual.get(ind.id) ?? [], programCode);
            return {
              id: ind.id,
              name: ind.displayName,
              preferredName: ind.preferredName,
              status: ind.status,
              archived: ind.status === "archived" || ind.archivedAt !== null,
              programs,
              budget,
            };
          });
          return <IndividualsList rows={rows} canEdit={canEdit} />;
        })()
      )}
    </>
  );
}

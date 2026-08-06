import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { PageHeader, ErrorPanel } from "@/components/ui";
import { BigStat, ProgressBar } from "@/components/ui-viz";
import { dec, formatHours, formatMoney, formatPercent } from "@/lib/money";
import CalculationsGrid from "@/components/calculations/calculations-grid";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projections — Ahivim Budget Management" };

function withinDays(iso: string | null, days: number): boolean {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const today = new Date();
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const diff = Math.round((new Date(`${iso}T00:00:00Z`).getTime() - t0) / 86400000);
  return diff >= 0 && diff <= days;
}

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

  const rows = result.ok ? result.data.strategies.rows : [];
  let planned = dec(0);
  let actual = dec(0);
  let scheduled = dec(0);
  let remaining = dec(0);
  let annual = dec(0);
  let overBudget = 0;
  let noActuals = 0;
  let renewingSoon = 0;
  for (const r of rows) {
    annual = annual.plus(dec(r.yearlyGross || 0));
    const a = r.analytics;
    if (a) {
      planned = planned.plus(dec(a.plannedHours));
      actual = actual.plus(dec(a.actualHours));
      scheduled = scheduled.plus(dec(a.scheduledHours));
      remaining = remaining.plus(dec(a.remainingHours));
      if (a.committedPercent && dec(a.committedPercent).greaterThan(1)) overBudget += 1;
      if (a.utilizationPercent != null && dec(a.utilizationPercent).isZero() && dec(a.plannedHours).greaterThan(0)) noActuals += 1;
    }
    if (withinDays(r.renewalDate, 60)) renewingSoon += 1;
  }
  const pctUsed = planned.greaterThan(0) ? actual.dividedBy(planned) : null;
  const pctUsedNum = pctUsed ? pctUsed.times(100).toNumber() : 0;
  const overallTone: "good" | "warn" | "danger" = remaining.isNegative() ? "danger" : pctUsedNum >= 90 ? "warn" : "good";

  const attention = rows.filter((r) => r.analytics && r.analytics.warnings.length > 0).slice(0, 6);

  return (
    <>
      <PageHeader
        eyebrow="Projections"
        title="Projections"
        description="Every budget in one editable grid. Enter only the renewal date and the 12-month period before it is derived automatically. Edit authorized hours and cuts inline; every figure is explained step by step, and utilization pacing shows whether the budget is on track before renewal."
      />

      {result.ok && rows.length > 0 ? (
        <div className="mb-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <BigStat label="Active budgets" value={rows.length.toLocaleString()} tone="primary" hint="Projection lines" />
            <BigStat label="Planned hours" value={formatHours(planned)} hint="Sum authorized" />
            <BigStat label="Used hours" value={formatHours(actual)} tone={overallTone} hint={pctUsed ? `${formatPercent(pctUsed)} of plan` : "no plan yet"} />
            <BigStat label="Scheduled" value={formatHours(scheduled)} tone={scheduled.isZero() ? "muted" : "info"} hint="not yet billed" />
            <BigStat label="Remaining" value={formatHours(remaining)} tone={remaining.isNegative() ? "danger" : "good"} hint="plan - used - scheduled" />
            <BigStat label="Annual value" value={formatMoney(annual)} hint="Sum yearly gross" />
          </div>

          <div className="card mt-3 px-5 py-4">
            <ProgressBar percent={pctUsedNum} tone={overallTone} label="Portfolio hours used against plan" />
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center rounded-full px-2 py-1 font-medium" style={{ color: "var(--color-danger)", background: "var(--color-danger-soft)" }}>
                {overBudget} over budget
              </span>
              <span className="inline-flex items-center rounded-full px-2 py-1 font-medium" style={{ color: "var(--color-warn)", background: "var(--color-warn-soft)" }}>
                {noActuals} no actuals yet
              </span>
              <span className="inline-flex items-center rounded-full px-2 py-1 font-medium" style={{ color: "var(--color-info)", background: "var(--color-info-soft)" }}>
                {renewingSoon} renewing within 60 days
              </span>
            </div>

            {attention.length > 0 ? (
              <div className="mt-4 border-t border-[var(--color-rule)] pt-3">
                <p className="eyebrow mb-2">Budgets that need a look</p>
                <ul className="space-y-1.5">
                  {attention.map((r) => {
                    const a = r.analytics!;
                    const up = a.utilizationPercent != null ? dec(a.utilizationPercent).times(100).toNumber() : 0;
                    const tone: "danger" | "warn" = a.warnings.includes("over-budget") || a.warnings.includes("plan exceeded") ? "danger" : "warn";
                    return (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                        <span className="min-w-40 flex-1">
                          {r.individualName}
                          <span className="text-[var(--color-ink-faint)]"> · {r.label}</span>
                        </span>
                        <span className="w-40">
                          <ProgressBar percent={up} tone={tone} showValue />
                        </span>
                        <span className="text-xs text-[var(--color-ink-faint)]">{a.warnings.join(" · ")}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

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

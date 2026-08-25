import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { canViewEmployee, canViewIndividual, hasDirectIndividualAccess, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { getIndividualBudgetView, getIndividualPeriodActivity } from "@/lib/data/queries";
import { BUDGET_STATUS_PRESENT, type BudgetLineStatus } from "@/lib/business/budget-status";
import { isUuid } from "@/lib/data/app-queries";
import { getIndividual } from "@/lib/manage/individuals";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { listAssignments } from "@/lib/manage/assignments";
import { listAliases } from "@/lib/manage/aliases";
import { scheduledByProgramForIndividual } from "@/lib/data/schedule-queries";
import { getPersonSettlementBalance } from "@/lib/data/settlements";
import {
  Card, Table, Th, Td, Tr, Money, Hours, ErrorPanel, PageHeader, ButtonLink,
} from "@/components/ui";
import { TabPanels } from "@/components/ui-client";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import BudgetEditor, { type BudgetEditorLine } from "@/components/individuals/budget-editor";
import BilledByMonth from "@/components/individuals/billed-by-month";
import EmployeesActivity from "@/components/individuals/employees-activity";
import FinancialPlan from "@/components/individuals/financial-plan";
import MergePanel from "@/components/individuals/merge-panel";
import AddPlanButton from "@/components/individuals/add-plan-button";
import { dec, formatHours, formatMoney } from "@/lib/money";
import { txLink } from "@/lib/nav/tx-link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individual — Ahivim Budget Management" };

/*
  The individual profile, rebuilt to answer one question first: WHERE ARE WE UP
  TO on this person's budget? It leads with a plain-language budget — used vs.
  authorized vs. left, per program, straight from the plan and the real
  transactions — then the money, then everything else folded away so a first-time
  reader is never buried. Authorized hours come from the same plan the Financial
  page uses, so the numbers here can never disagree with any other screen.
*/

function StatusPill({ status }: { status: BudgetLineStatus }) {
  const s = BUDGET_STATUS_PRESENT[status];
  return (
    <span className="badge" style={{ background: s.tint, color: s.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

/** A used-vs-authorized bar with a marker for how far the period has elapsed. */
function BudgetBar({ usagePercent, elapsedPercent, color }: { usagePercent: number | null; elapsedPercent: number | null; color: string }) {
  const rawUsed = usagePercent === null ? 0 : Math.max(0, usagePercent * 100);
  const used = Math.min(100, rawUsed);
  const over = Math.max(0, rawUsed - 100);
  return (
    <div>
      <div className={`pace-track ${over > 0 ? "pace-track-over" : ""}`} role="img" aria-label={`${Math.round(rawUsed)}% of hours used`}
        title={elapsedPercent !== null ? `${Math.round(rawUsed)}% of hours used · ${Math.round(elapsedPercent)}% of the year elapsed` : `${Math.round(rawUsed)}% of hours used`}>
        <div className="pace-fill" style={{ width: `${used}%`, background: over > 0 ? "var(--color-danger)" : color }} />
        {elapsedPercent !== null ? <div className="pace-notch" style={{ left: `${Math.max(0, Math.min(100, elapsedPercent))}%` }} /> : null}
      </div>
      {over > 0 ? <p className="pace-overflow-label">Over by {Math.round(over)}%</p> : null}
    </div>
  );
}

function renewLine(active: boolean, daysToRenewal: number | null, effectiveRenewal: string | null): string {
  if (!effectiveRenewal) return "No renewal date on file";
  if (!active) return `Inactive · renewal frozen at ${effectiveRenewal}`;
  if (daysToRenewal === null) return `Renews ${effectiveRenewal}`;
  if (daysToRenewal <= 0) return `Renews today (${effectiveRenewal})`;
  return `Renews in ${daysToRenewal} day${daysToRenewal === 1 ? "" : "s"} (${effectiveRenewal})`;
}

export default async function IndividualDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ view?: string | string[] }>;
}) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const [{ id }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<{ view?: string | string[] }>({}),
  ]);
  const initialView = typeof query.view === "string" ? query.view : undefined;
  if (!isUuid(id)) notFound();

  const result = await withDb(async (pool) => {
    const individual = await getIndividual(pool, id);
    if (!individual) return null;
    // A scoped user may only open an individual they have access to.
    const scope = await resolveAccessScope(pool, user);
    if (!canViewIndividual(scope, id)) return null;
    const directAccess = hasDirectIndividualAccess(scope, id);
    const canSeeBudgets = scope.canSeeBudgets && scope.canSeeHours && directAccess;
    const canSeeSettlements = scope.canSeeSettlements && directAccess;
    const budget = await getIndividualBudgetView(pool, id, undefined, scope);
    const [strategies, assignments, aliasesAll, scheduledByProgram, activity, settlement] = await Promise.all([
      canSeeBudgets
        ? listStrategies(pool, { individualId: id, withAnalytics: true })
        : Promise.resolve({ rows: [], programs: [] }),
      listAssignments(pool, { individualId: id, includeInactive: true }),
      listAliases(pool, { kind: "individual" }),
      directAccess
        ? scheduledByProgramForIndividual(pool, id)
        : Promise.resolve<Record<string, { hours: string; internal: string }>>({}),
      canSeeBudgets
        ? getIndividualPeriodActivity(
            pool,
            id,
            budget.periodStart,
            budget.periodEnd,
            scope,
            budget.lines
              .filter((line) => line.inPlan)
              .map((line) => ({ id: line.programId, name: line.programName, code: line.programCode })),
          )
        : Promise.resolve({ periods: [], byEmployee: [] }),
      canSeeSettlements ? getPersonSettlementBalance(pool, { individualId: id }) : Promise.resolve({ payable: "0", receivable: "0", reserve: "0", credit: "0", openItems: 0 }),
    ]);
    // The plan the main view describes (matches the budget board), plus any OTHER
    // plans this individual has — each gets its own budget view so a second plan
    // (different programs / different cuts) shows in full.
    const activeStrategies = strategies.rows.filter((s) => s.status === "active");
    const strategy = activeStrategies.find((s) => s.id === budget.strategyId) ?? activeStrategies[0] ?? null;
    const others = activeStrategies.filter((s) => s.id !== (strategy?.id ?? budget.strategyId));
    const otherPlans = await Promise.all(
      others.map(async (s) => ({ strategy: s, budget: await getIndividualBudgetView(pool, id, s.id, scope) })),
    );
    const visibleActivity = {
      periods: activity.periods.map((period) => ({
        ...period,
        byProgramMonth: period.byProgramMonth.map((row) => ({
          ...row,
          hours: scope.canSeeHours ? row.hours : "0",
          agency: scope.canSeeBilledAmounts ? row.agency : "0",
          internal: scope.canSeeEmployeeAmounts ? row.internal : "0",
        })),
        programs: period.programs.map((row) => ({
          ...row,
          hours: scope.canSeeHours ? row.hours : "0",
          agency: scope.canSeeBilledAmounts ? row.agency : "0",
          internal: scope.canSeeEmployeeAmounts ? row.internal : "0",
        })),
      })),
      byEmployee: activity.byEmployee.map((employee) => ({
        ...employee,
        hours: scope.canSeeHours ? employee.hours : "0",
        agency: scope.canSeeBilledAmounts ? employee.agency : "0",
        internal: scope.canSeeEmployeeAmounts ? employee.internal : "0",
        txCount: scope.canSeeTransactions ? employee.txCount : 0,
        transactions: scope.canSeeTransactions
          ? employee.transactions.map((row) => ({
              ...row,
              hours: scope.canSeeHours ? row.hours : "0",
              agency: scope.canSeeBilledAmounts ? row.agency : "0",
              internal: scope.canSeeEmployeeAmounts ? row.internal : "0",
            }))
          : [],
      })),
    };
    return {
      individual, budget, activity: visibleActivity, settlement,
      strategy,
      otherPlans,
      canSeeHours: scope.canSeeHours,
      canSeeBilledAmounts: scope.canSeeBilledAmounts,
      canSeeEmployeeAmounts: scope.canSeeEmployeeAmounts,
      canSeeAgencySpread: scope.canSeeAgencySpread,
      canSeeBudgets,
      canSeeSettlements,
      canSeeTransactions: scope.canSeeTransactions,
      programs: strategies.programs, // program list with default per-hour rates, for the editor
      assignments: assignments.filter((a) => a.status === "active" && canViewEmployee(scope, a.employeeId)),
      aliases: aliasesAll.filter((a) => a.canonicalId === id),
      scheduled: Object.entries(scheduledByProgram).map(([code, scheduled]) => [
        code,
        {
          hours: scope.canSeeHours ? scheduled.hours : "0",
          internal: scope.canSeeEmployeeAmounts ? scheduled.internal : "0",
        },
      ] as [string, { hours: string; internal: string }]),
    };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Individual" title="Individual" />
        <ErrorPanel title="Could not load this individual">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();

  const {
    individual, budget, activity, settlement, strategy, otherPlans,
    canSeeHours, canSeeBilledAmounts, canSeeEmployeeAmounts, canSeeAgencySpread,
    canSeeBudgets, canSeeSettlements, canSeeTransactions, programs, assignments, aliases, scheduled,
  } = result.data;
  const t = budget.totals;
  const headline = budget.headline ? BUDGET_STATUS_PRESENT[budget.headline] : null;

  // Months left until the (rolled) renewal, for the financial plan's remaining pace.
  const monthsToRenewal = budget.daysToRenewal !== null && budget.daysToRenewal > 0 ? budget.daysToRenewal / 30.4375 : null;
  // "bill X h/month to finish" — summed per program, each toward its OWN renewal
  // (Day Hab / Supplemental on the calendar year), computed in the read model.
  const perMonthToFinish = budget.perMonthToFinish ? dec(budget.perMonthToFinish) : null;
  const employeeActivityPeriod = activity.periods.length === 1 ? activity.periods[0] : null;

  const editorLines: BudgetEditorLine[] = budget.lines.map((l) => ({
    programId: l.programId,
    programName: l.programName,
    perHour: canSeeEmployeeAmounts ? l.perHour : "0",
    authorizedHours: l.authorizedHours,
    usedHours: l.usedHours,
    inPlan: l.inPlan,
    daysToRenewal: l.daysToRenewal,
    effectiveRenewal: l.effectiveRenewal,
    calendarYear: l.calendarYear,
  }));
  const editorPrograms = programs.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    defaultRate: canSeeEmployeeAmounts ? p.internalRate : "0",
  }));

  /* ---- header action: edit the person's name/notes. Active/inactive is a
     switch inside the budget below, not an outside button. ---- */
  const headerActions = canEdit ? (
    <div className="flex flex-wrap items-center gap-2">
      <MergePanel individualId={id} individualName={individual.displayName} />
      <CreateButton
        label="Edit name"
        title="Edit individual"
        endpoint={`/api/individuals/${id}`}
        method="PATCH"
        variant="secondary"
        fields={
          <>
            <Field label="Display name" name="displayName" defaultValue={individual.displayName} required />
            <Field label="Preferred name" name="preferredName" defaultValue={individual.preferredName} />
            <Field label="Legal name" name="legalName" defaultValue={individual.legalName} />
            <TextAreaField label="Notes" name="notes" defaultValue={individual.notes} />
          </>
        }
      />
    </div>
  ) : (
    <ButtonLink href="/individuals">All individuals</ButtonLink>
  );

  return (
    <>
      <PageHeader eyebrow="Individual" title={individual.displayName} action={headerActions} />
      <TabPanels
        initialId={initialView}
        paramKey="view"
        panels={[
          {
            id: "overview",
            label: "Overview",
            content: canSeeBudgets && budget.hasPlan ? (
              <section className="card fade-in-up px-5 py-5" style={{ borderTop: `3px solid ${headline?.color ?? "var(--color-primary)"}` }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="eyebrow">Budget this period</p>
                    <p className="mt-1 text-2xl font-semibold leading-tight">
                      Used <span className="tnum">{formatHours(t.usedHours)}</span> of <span className="tnum">{formatHours(t.authorizedHours)}</span> hours
                    </p>
                    <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                      <span className="tnum font-medium" style={{ color: dec(t.remainingHours).isNegative() ? "var(--color-pace-over)" : "var(--color-ink)" }}>
                        {formatHours(t.remainingHours)} h {dec(t.remainingHours).isNegative() ? "over" : "left"}
                      </span>
                      {" · "}{renewLine(budget.active, budget.daysToRenewal, budget.effectiveRenewal)}
                    </p>
                    {perMonthToFinish && (budget.daysToRenewal === null || budget.daysToRenewal >= 30) ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        Required pace: <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(perMonthToFinish.toString())} h/month</span>
                      </p>
                    ) : budget.daysToRenewal !== null && budget.daysToRenewal > 0 && budget.daysToRenewal < 30 && dec(t.remainingHours).greaterThan(0) ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(t.remainingHours)} h</span> remain for the next {budget.daysToRenewal} days.
                      </p>
                    ) : null}
                  </div>
                  {headline ? <StatusPill status={budget.headline!} /> : null}
                </div>
                <div className="mt-4 max-w-xl">
                  <BudgetBar usagePercent={t.usagePercent} elapsedPercent={budget.timeElapsedPercent} color={headline?.color ?? "var(--color-pace-on)"} />
                </div>
              </section>
            ) : canSeeBudgets ? (
              <section className="card px-5 py-5">
                <p className="eyebrow">Budget</p>
                <p className="mt-1 text-lg font-semibold">No budget is configured</p>
                {canSeeTransactions && budget.money.txCount > 0 ? (
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{budget.money.txCount.toLocaleString()} billed transactions are already on file.</p>
                ) : null}
              </section>
            ) : (
              <section className="card px-5 py-5">
                <p className="eyebrow">Current profile</p>
                <p className="mt-1 text-lg font-semibold">{assignments.length} active employee assignment{assignments.length === 1 ? "" : "s"}</p>
              </section>
            ),
          },
          ...(canSeeBudgets ? [{
            id: "budget",
            label: "Budget",
            content: (
              <div className="space-y-6">
                {budget.lines.length > 0 || canEdit ? (
                  <BudgetEditor
                    individualId={id}
                    strategyId={budget.strategyId}
                    active={budget.active}
                    renewalDate={budget.renewalDate}
                    effectiveRenewal={budget.effectiveRenewal}
                    periodStart={budget.periodStart}
                    periodEnd={budget.periodEnd}
                    lines={editorLines}
                    programs={editorPrograms}
                    canEdit={canEdit}
                    canSeeMoney={canSeeEmployeeAmounts}
                  />
                ) : (
                  <section className="card px-5 py-5 text-sm text-[var(--color-ink-soft)]">No budget lines are configured.</section>
                )}
                {activity.periods.length > 0 ? (
                  <Card
                    title={canSeeTransactions ? "Billing history" : "Service history"}
                    description={activity.periods.length > 1
                      ? "Each program is shown in the budget year that controls its used and remaining amounts."
                      : "Monthly service activity for the current budget year."}
                  >
                    <BilledByMonth
                      periods={activity.periods}
                      canSeeHours={canSeeHours}
                      canSeeBilledAmounts={canSeeBilledAmounts}
                      canSeeEmployeeAmounts={canSeeEmployeeAmounts}
                      canSeeTransactions={canSeeTransactions}
                    />
                  </Card>
                ) : null}
                {otherPlans.map((op) => (
                  <section key={op.strategy.id}>
                    <p className="eyebrow mb-2">Plan · {op.strategy.label}</p>
                    <BudgetEditor
                      individualId={id}
                      strategyId={op.budget.strategyId}
                      active={op.budget.active}
                      renewalDate={op.budget.renewalDate}
                      effectiveRenewal={op.budget.effectiveRenewal}
                      periodStart={op.budget.periodStart}
                      periodEnd={op.budget.periodEnd}
                      lines={op.budget.lines.map((l) => ({ programId: l.programId, programName: l.programName, perHour: canSeeEmployeeAmounts ? l.perHour : "0", authorizedHours: l.authorizedHours, usedHours: l.usedHours, inPlan: l.inPlan, daysToRenewal: l.daysToRenewal, effectiveRenewal: l.effectiveRenewal, calendarYear: l.calendarYear }))}
                      programs={editorPrograms}
                      canEdit={canEdit}
                      canSeeMoney={canSeeEmployeeAmounts}
                    />
                  </section>
                ))}
                {canEdit && strategy ? <AddPlanButton individualId={id} nextLabel={String(otherPlans.length + 2)} /> : null}
              </div>
            ),
          }] : []),
          ...(canSeeBudgets ? [{
            id: "activity",
            label: "Activity",
            content: (
              <div className="space-y-6">
                {activity.byEmployee.length > 0 ? (
                  <Card
                    title="Employees working with this individual"
                    description={canSeeTransactions
                      ? "Employees with billed activity in the current program budget periods."
                      : "Employees with recorded service activity in the current program budget periods."}
                    action={canSeeTransactions ? <ButtonLink href={txLink({ individualId: id, pbFrom: employeeActivityPeriod?.start, pbTo: employeeActivityPeriod?.end })} variant="secondary">All rows →</ButtonLink> : undefined}
                  >
                    <EmployeesActivity
                      individualId={id}
                      periodStart={employeeActivityPeriod?.start ?? null}
                      periodEnd={employeeActivityPeriod?.end ?? null}
                      employees={activity.byEmployee}
                      canSeeHours={canSeeHours}
                      canSeeBilledAmounts={canSeeBilledAmounts}
                      canSeeEmployeeAmounts={canSeeEmployeeAmounts}
                      canSeeTransactions={canSeeTransactions}
                    />
                  </Card>
                ) : null}
                {activity.periods.every((period) => period.byProgramMonth.length === 0) && activity.byEmployee.length === 0 ? (
                  <section className="card px-5 py-5 text-sm text-[var(--color-ink-soft)]">No activity is recorded for this budget period.</section>
                ) : null}
              </div>
            ),
          }] : []),
          ...(canSeeSettlements || (canSeeBudgets && (
            ((canSeeBilledAmounts || canSeeEmployeeAmounts) && budget.money.txCount > 0)
            || (canSeeBilledAmounts && canSeeEmployeeAmounts && canSeeAgencySpread && strategy && budget.hasPlan)
            || otherPlans.some((plan) => canSeeBilledAmounts && canSeeEmployeeAmounts && canSeeAgencySpread && plan.budget.hasPlan)
          )) ? [{
            id: "money",
            label: "Money",
            content: (
              <div className="space-y-6">
                {canSeeBudgets && (canSeeBilledAmounts || canSeeEmployeeAmounts) && budget.money.txCount > 0 ? (
                  <Card
                    title="Money this budget year"
                    description="Funder billed and employee base within the active budget year."
                    action={canSeeTransactions ? <ButtonLink href={txLink({ individualId: id, pbFrom: budget.periodStart ?? undefined, pbTo: budget.periodEnd ?? undefined })} variant="secondary">See these rows →</ButtonLink> : undefined}
                  >
                    <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
                      {canSeeBilledAmounts ? <MoneyTile label="Funder billed" value={formatMoney(budget.money.agencyBilled)} /> : null}
                      {canSeeEmployeeAmounts ? <MoneyTile label="Employee base" value={formatMoney(budget.money.internalBilled)} /> : null}
                      <MoneyTile label="Transactions" value={budget.money.txCount.toLocaleString()} plain />
                    </div>
                  </Card>
                ) : null}
                {canSeeSettlements ? (
                  <section className="border-y border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-4 sm:px-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="eyebrow">Payment balance</p>
                        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Recorded reserves, fees, credits, and open items.</p>
                      </div>
                      <ButtonLink href={`/settlements?individualId=${id}`} variant="secondary">Open payments</ButtonLink>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                      <div><p className="text-xs text-[var(--color-ink-faint)]">Still to set aside</p><p className="tnum mt-0.5 text-lg font-semibold">{formatMoney(settlement.reserve)}</p></div>
                      <div><p className="text-xs text-[var(--color-ink-faint)]">Fees to collect</p><p className="tnum mt-0.5 text-lg font-semibold">{formatMoney(settlement.receivable)}</p></div>
                      <div><p className="text-xs text-[var(--color-ink-faint)]">Credit</p><p className="tnum mt-0.5 text-lg font-semibold">{formatMoney(settlement.credit)}</p></div>
                      <div><p className="text-xs text-[var(--color-ink-faint)]">Open items</p><p className="tnum mt-0.5 text-lg font-semibold">{settlement.openItems}</p></div>
                    </div>
                  </section>
                ) : null}
                {canSeeBudgets && canSeeBilledAmounts && canSeeEmployeeAmounts && canSeeAgencySpread && strategy && budget.hasPlan ? (
                  <Card
                    title={otherPlans.length > 0 ? `Plan and actuals · ${strategy.label}` : "Plan and actuals"}
                    description="Annual plan targets compared with actual transactions in the current budget year."
                  >
                    <FinancialPlan
                      strategyId={strategy.id}
                      lines={budget.lines}
                      strategy={strategy}
                      timeElapsedPercent={budget.timeElapsedPercent}
                      monthsToRenewal={monthsToRenewal}
                      canManage={canEdit}
                    />
                  </Card>
                ) : null}
                {otherPlans.map((op) => canSeeBilledAmounts && canSeeEmployeeAmounts && canSeeAgencySpread && op.budget.hasPlan ? (
                  <Card key={op.strategy.id} title={`Plan and actuals · ${op.strategy.label}`}>
                    <FinancialPlan
                      strategyId={op.strategy.id}
                      lines={op.budget.lines}
                      strategy={op.strategy}
                      timeElapsedPercent={op.budget.timeElapsedPercent}
                      monthsToRenewal={op.budget.daysToRenewal !== null && op.budget.daysToRenewal > 0 ? op.budget.daysToRenewal / 30.4375 : null}
                      canManage={canEdit}
                    />
                  </Card>
                ) : null)}
              </div>
            ),
          }] : []),
          {
            id: "details",
            label: "Details",
            content: (
              <MoreDetails
                assignments={assignments}
                aliases={aliases}
                scheduled={scheduled}
                canSeeHours={canSeeHours}
                canSeeEmployeeAmounts={canSeeEmployeeAmounts}
                notes={individual.notes}
              />
            ),
          },
        ]}
      />
    </>
  );
}

/* ---------------------------------------------------------------- pieces */

function MoneyTile({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-2.5">
      <p className="eyebrow text-[var(--color-text-soft)]">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${plain ? "" : "tnum"}`}>{value}</p>
    </div>
  );
}

/* Supporting profile details, shown in their own workspace tab. */
function MoreDetails({
  assignments, aliases, scheduled, canSeeHours, canSeeEmployeeAmounts, notes,
}: {
  assignments: Awaited<ReturnType<typeof listAssignments>>;
  aliases: { id: string; importedName: string; status: string }[];
  scheduled: [string, { hours: string; internal: string }][];
  canSeeHours: boolean;
  canSeeEmployeeAmounts: boolean;
  notes: string | null;
}) {
  const hasAnything = assignments.length > 0 || scheduled.length > 0 || aliases.length > 0 || !!notes;
  if (!hasAnything) {
    return (
      <section className="card px-5 py-5">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Profile details</h2>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">No additional profile details are recorded.</p>
      </section>
    );
  }
  return (
    <section className="card px-5 py-5">
      <h2 className="text-base font-semibold text-[var(--color-ink)]">Profile details</h2>
      <div className="mt-5 space-y-6">
        {assignments.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Assigned employees</p>
            <Table head={<><Th>Employee</Th><Th>Program</Th>{canSeeHours ? <Th numeric>Allowed hours</Th> : null}</>}>
              {assignments.map((a) => (
                <Tr key={a.id}>
                  <Td><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/employees/${a.employeeId}`}>{a.employeeName}</Link></Td>
                  <Td>{a.programName ?? "Any"}</Td>
                  {canSeeHours ? <Td numeric>{a.allowedHours ? <Hours value={a.allowedHours} /> : "—"}</Td> : null}
                </Tr>
              ))}
            </Table>
          </div>
        ) : null}

        {scheduled.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Scheduled hours</p>
            <Table head={<><Th>Program</Th>{canSeeHours ? <Th numeric>Hours</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Expected employee base</Th> : null}</>}>
              {scheduled.map(([code, sc]) => (
                <Tr key={code}><Td>{code}</Td>{canSeeHours ? <Td numeric><Hours value={sc.hours} /></Td> : null}{canSeeEmployeeAmounts ? <Td numeric><Money value={sc.internal} /></Td> : null}</Tr>
              ))}
            </Table>
          </div>
        ) : null}

        {aliases.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Known spellings</p>
            <p className="text-sm text-[var(--color-ink-soft)]">{aliases.map((a) => a.importedName).join(", ")}</p>
          </div>
        ) : null}

        {notes ? (
          <div>
            <p className="eyebrow mb-2">Notes</p>
            <p className="whitespace-pre-wrap text-sm">{notes}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

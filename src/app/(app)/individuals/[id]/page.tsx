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
  const used = usagePercent === null ? 0 : Math.max(0, Math.min(100, usagePercent * 100));
  return (
    <div className="pace-track" role="img" aria-label={`${Math.round(used)}% of hours used`}
      title={elapsedPercent !== null ? `${Math.round(used)}% of hours used · ${Math.round(elapsedPercent)}% of the year elapsed` : `${Math.round(used)}% of hours used`}>
      <div className="pace-fill" style={{ width: `${used}%`, background: color }} />
      {elapsedPercent !== null ? <div className="pace-notch" style={{ left: `${Math.max(0, Math.min(100, elapsedPercent))}%` }} /> : null}
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

export default async function IndividualDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const { id } = await params;
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
        ? getIndividualPeriodActivity(pool, id, budget.periodStart, budget.periodEnd, scope)
        : Promise.resolve({ byProgramMonth: [], programsBilled: [], byEmployee: [] }),
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
      byProgramMonth: activity.byProgramMonth.map((row) => ({
        ...row,
        hours: scope.canSeeHours ? row.hours : "0",
        agency: scope.canSeeBilledAmounts ? row.agency : "0",
        internal: scope.canSeeEmployeeAmounts ? row.internal : "0",
      })),
      programsBilled: activity.programsBilled.map((row) => ({
        ...row,
        hours: scope.canSeeHours ? row.hours : "0",
        agency: scope.canSeeBilledAmounts ? row.agency : "0",
        internal: scope.canSeeEmployeeAmounts ? row.internal : "0",
      })),
      byEmployee: activity.byEmployee.map((employee) => ({
        ...employee,
        hours: scope.canSeeHours ? employee.hours : "0",
        agency: scope.canSeeBilledAmounts ? employee.agency : "0",
        internal: scope.canSeeEmployeeAmounts ? employee.internal : "0",
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
      scheduled: Object.entries(scheduledByProgram),
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

      {/* ---- The one-glance answer: where are we up to? ---- */}
      {canSeeBudgets && budget.hasPlan ? (
        <section className="card fade-in-up mb-6 px-5 py-5" style={{ borderTop: `3px solid ${headline?.color ?? "var(--color-primary)"}` }}>
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
                  To use it all by renewal, bill <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(perMonthToFinish.toString())} h/month</span> from now.
                </p>
              ) : budget.daysToRenewal !== null && budget.daysToRenewal > 0 && budget.daysToRenewal < 30 && dec(t.remainingHours).greaterThan(0) ? (
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(t.remainingHours)} h</span> left to bill in the {budget.daysToRenewal} days before it renews — see each program below.
                </p>
              ) : null}
            </div>
            {headline ? <StatusPill status={budget.headline!} /> : null}
          </div>
          <div className="mt-4 max-w-xl">
            <BudgetBar usagePercent={t.usagePercent} elapsedPercent={budget.timeElapsedPercent} color={headline?.color ?? "var(--color-pace-on)"} />
            <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
              The bar is hours used; the notch is how far the year has gone. Fill past the notch = using faster than time; short of it = slower.
            </p>
          </div>
        </section>
      ) : canSeeBudgets ? (
        <section className="card mb-6 px-5 py-5">
          <p className="eyebrow">Budget</p>
          <p className="mt-1 text-lg font-semibold">No budget set yet</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            {canEdit
              ? "Add this person's programs, hours and renewal date in the budget below — it's all editable right here."
              : "Once this person has a budget, this is where you'll see used vs. left for every program."}
            {budget.money.txCount > 0 ? ` They already have ${budget.money.txCount.toLocaleString()} billed transactions on file.` : ""}
          </p>
        </section>
      ) : null}

      {/* ---- Budget by program — editable inline, shaped like the rollover sheet ---- */}
      {canSeeBudgets && (budget.lines.length > 0 || canEdit) ? (
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
      ) : null}

      {/* ---- Money billed this period (this budget year only) ---- */}
      {canSeeBudgets && (canSeeBilledAmounts || canSeeEmployeeAmounts) && budget.money.txCount > 0 ? (
        <Card title="Money billed this period" description="This budget year only — not the whole history. Agency is what was invoiced; company is the internal amount." className="mb-6"
          action={canSeeTransactions ? <ButtonLink href={txLink({ individualId: id, pbFrom: budget.periodStart ?? undefined, pbTo: budget.periodEnd ?? undefined })} variant="secondary">See these rows →</ButtonLink> : undefined}>
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
            {canSeeBilledAmounts ? <MoneyTile label="Agency total (billed)" value={formatMoney(budget.money.agencyBilled)} /> : null}
            {canSeeEmployeeAmounts ? <MoneyTile label="Company (internal)" value={formatMoney(budget.money.internalBilled)} /> : null}
            <MoneyTile label="Transactions" value={budget.money.txCount.toLocaleString()} plain />
          </div>
        </Card>
      ) : null}

      {/* ---- Billed by month, itemized by program ---- */}
      {canSeeBudgets && budget.periodStart && activity.programsBilled.length > 0 ? (
        <Card
          title="Billed by month"
          description={
            !canSeeBilledAmounts && !canSeeEmployeeAmounts
              ? "What was billed each month this renewal year, itemized by program. Hours are shown per program."
              : budget.lines.some((l) => l.calendarYear)
              ? "What was billed each month across this renewal year, itemized by program (month totals in dollars). Note: Day Hab and Supplemental run their own Jan–Jan budget year, so their monthly activity here can differ from their budget “used” above."
              : "What was billed each month this renewal year, itemized by program. Hours are per program; the month totals are in dollars — Billed (agency, invoiced) and Company (internal) — because hours don't add up across programs."
          }
          className="mb-6"
        >
          <BilledByMonth
            periodStart={budget.periodStart}
            byProgramMonth={activity.byProgramMonth}
            programsBilled={activity.programsBilled}
            canSeeHours={canSeeHours}
            canSeeBilledAmounts={canSeeBilledAmounts}
            canSeeEmployeeAmounts={canSeeEmployeeAmounts}
          />
        </Card>
      ) : null}

      {/* ---- Employees working with this individual — expandable to their rows ---- */}
      {canSeeBudgets && activity.byEmployee.length > 0 ? (
        <Card
          title="Employees working with this individual"
          description={canSeeTransactions
            ? "Who did the work this budget year. Expand an employee for their transactions, or open the filtered full grid."
            : "Who did the work this budget year."}
          className="mb-6"
          action={canSeeTransactions ? <ButtonLink href={txLink({ individualId: id, pbFrom: budget.periodStart ?? undefined, pbTo: budget.periodEnd ?? undefined })} variant="secondary">All rows →</ButtonLink> : undefined}
        >
          <EmployeesActivity
            individualId={id}
            periodStart={budget.periodStart}
            periodEnd={budget.periodEnd}
            employees={activity.byEmployee}
            canSeeHours={canSeeHours}
            canSeeBilledAmounts={canSeeBilledAmounts}
            canSeeEmployeeAmounts={canSeeEmployeeAmounts}
            canSeeTransactions={canSeeTransactions}
          />
        </Card>
      ) : null}

      {canSeeSettlements ? (
        <section className="mb-6 border-y border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="eyebrow">Settlement balance</p>
              <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                {canSeeBudgets && strategy && budget.hasPlan
                  ? "The plan stays fixed for the year; settlement activity records what has actually been set aside."
                  : "Amounts still to set aside or collect, after recorded settlement activity."}
              </p>
            </div>
            <ButtonLink href={`/settlements?individualId=${id}`} variant="secondary">Open settlement ledger</ButtonLink>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <div><p className="text-xs text-[var(--color-ink-faint)]">Still to set aside</p><p className="tnum mt-0.5 text-lg font-semibold">{formatMoney(settlement.reserve)}</p></div>
            <div><p className="text-xs text-[var(--color-ink-faint)]">Fees to collect</p><p className="tnum mt-0.5 text-lg font-semibold">{formatMoney(settlement.receivable)}</p></div>
            <div><p className="text-xs text-[var(--color-ink-faint)]">Credit</p><p className="tnum mt-0.5 text-lg font-semibold">{formatMoney(settlement.credit)}</p></div>
            <div><p className="text-xs text-[var(--color-ink-faint)]">Open items</p><p className="tnum mt-0.5 text-lg font-semibold">{settlement.openItems}</p></div>
          </div>
        </section>
      ) : null}

      {/* ---- Financial plan: projected vs. actual, both currencies, cuts inline ---- */}
      {canSeeBudgets && canSeeBilledAmounts && canSeeEmployeeAmounts && canSeeAgencySpread && strategy && budget.hasPlan ? (
        <Card
          title={otherPlans.length > 0 ? `Financial plan · ${strategy.label}` : "Financial plan"}
          description="Projected vs. actual. The plan is the budget priced out through the two cuts and doesn't move; the actual values the hours billed so far at the same rates — so you can see how much you're off and what's left to bill, in both the agency and company currencies."
          className="mb-6"
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

      {/* ---- Additional plans: some individuals have a second plan (different
             programs, different cuts) — each shows its own budget + cuts in full. ---- */}
      {otherPlans.map((op) => (
        <div key={op.strategy.id} className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full bg-[var(--color-primary-tint)] px-2.5 py-0.5 text-xs font-semibold text-[var(--color-primary)]">Plan · {op.strategy.label}</span>
            <span className="text-xs text-[var(--color-ink-faint)]">a separate plan for this individual — its own programs and cuts</span>
          </div>
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
          {canSeeBilledAmounts && canSeeEmployeeAmounts && canSeeAgencySpread && op.budget.hasPlan ? (
            <Card title={`Financial plan · ${op.strategy.label}`} className="mt-0">
              <FinancialPlan
                strategyId={op.strategy.id}
                lines={op.budget.lines}
                strategy={op.strategy}
                timeElapsedPercent={op.budget.timeElapsedPercent}
                monthsToRenewal={op.budget.daysToRenewal !== null && op.budget.daysToRenewal > 0 ? op.budget.daysToRenewal / 30.4375 : null}
                canManage={canEdit}
              />
            </Card>
          ) : null}
        </div>
      ))}

      {canEdit && strategy ? (
        <div className="mb-6">
          <AddPlanButton individualId={id} nextLabel={String(otherPlans.length + 2)} />
        </div>
      ) : null}

      {/* ---- Everything else, folded away and only if it has content ---- */}
      <MoreDetails
        assignments={assignments}
        aliases={aliases}
        scheduled={scheduled}
        canSeeHours={canSeeHours}
        canSeeEmployeeAmounts={canSeeEmployeeAmounts}
        notes={individual.notes}
      />

      <p className="mt-6 text-xs text-[var(--color-ink-faint)]">
        Used hours are the real billed transactions inside this renewal year, so every number here matches the Transactions grid and the Financial page.
      </p>
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

/* Everything advanced, collapsed by default and hidden entirely when empty. */
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
  if (!hasAnything) return null;
  return (
    <details className="card px-5 py-4">
      <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">More details</summary>
      <div className="mt-4 space-y-6">
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
            <p className="eyebrow mb-2">Scheduled, not yet billed</p>
            <Table head={<><Th>Program</Th>{canSeeHours ? <Th numeric>Hours</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Expected</Th> : null}</>}>
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
    </details>
  );
}

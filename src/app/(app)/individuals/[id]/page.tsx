import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { canViewEmployee, canViewIndividual, hasDirectIndividualAccess, resolveAccessScope } from "@/lib/auth/access";
import { canManageHourAuthorizations } from "@/lib/auth/hour-authorization-access";
import { withDb } from "@/lib/data/pool";
import { getIndividualBudgetView, getIndividualPeriodActivity } from "@/lib/data/queries";
import { BUDGET_STATUS_PRESENT, type BudgetLineStatus } from "@/lib/business/budget-status";
import { isUuid, listPrograms } from "@/lib/data/app-queries";
import { getIndividual } from "@/lib/manage/individuals";
import { listAuthorizationsForIndividual } from "@/lib/manage/authorizations";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { listAssignments } from "@/lib/manage/assignments";
import { listAliases } from "@/lib/manage/aliases";
import { scheduledByProgramForIndividual } from "@/lib/data/schedule-queries";
import { getPersonSettlementBalance } from "@/lib/data/settlements";
import { listClassBudgets, listClassInvoices } from "@/lib/data/class-invoices";
import {
  listProgramBudgetEvents,
  listProgramBudgetMonthlyHistory,
  listProgramBudgets,
} from "@/lib/data/program-budgets";
import { summarizeAuthorizationPortfolio } from "@/lib/data/authorization-portfolio";
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
import ProgramBudgetWorkspace from "@/components/individuals/program-budget-workspace";
import { dec, formatHours, formatMoney } from "@/lib/money";
import { txLink } from "@/lib/nav/tx-link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individual — Ahivim Budget Management" };

/*
  The individual profile leads with the operational authorization truth:
  authorized, transaction-backed used, pending scheduled, and remaining hours
  from program_budget_balances. Calculation strategies remain a separate
  Financial Setup concern and never define the operational Budget tab.
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
    const [individual, scope] = await Promise.all([
      getIndividual(pool, id),
      resolveAccessScope(pool, user),
    ]);
    if (!individual) return null;
    // A scoped user may only open an individual they have access to.
    if (!canViewIndividual(scope, id)) return null;
    const directAccess = hasDirectIndividualAccess(scope, id);
    const canSeeBudgets = scope.canSeeBudgets && scope.canSeeHours && directAccess;
    const canSeeAnyProgramDollars = (scope.canSeeBilledAmounts || scope.canSeeClassFinancials) && directAccess;
    const canSeeProgramBudgets = canSeeBudgets || canSeeAnyProgramDollars;
    const canSeeSettlements = scope.canSeeSettlements && directAccess;
    const canSeeClasses = scope.canSeeClassFinancials && directAccess;
    const canManageHours = canManageHourAuthorizations(scope) && directAccess;
    const budget = await getIndividualBudgetView(pool, id, undefined, scope);
    const [strategies, assignments, aliasesAll, scheduledByProgram, activity, settlement, classBudgets, classInvoices, programBudgetsRaw, programCatalogRaw, authorizationHistoryRaw] = await Promise.all([
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
      canSeeClasses ? listClassBudgets(pool, scope, { individualId: id }) : Promise.resolve([]),
      canSeeClasses ? listClassInvoices(pool, scope, { individualId: id }) : Promise.resolve([]),
      canSeeProgramBudgets ? listProgramBudgets(pool, { individualId: id }) : Promise.resolve([]),
      canEdit || canManageHours ? listPrograms(pool) : Promise.resolve([]),
      canSeeProgramBudgets
        ? listAuthorizationsForIndividual(pool, id)
        : Promise.resolve({ periods: [], authorizations: [] }),
    ]);
    const canSeeRowDollars = (serviceCategory: string) => directAccess && (
      serviceCategory === "classes" ? scope.canSeeClassFinancials : scope.canSeeBilledAmounts
    );
    const visibleProgramBudgetRows = programBudgetsRaw.filter((row) => {
      const hasVisibleHours = canSeeBudgets && row.requiredAuthType !== "dollars";
      const hasVisibleDollars = canSeeRowDollars(row.serviceCategory) && row.requiredAuthType !== "hours";
      return hasVisibleHours || hasVisibleDollars;
    });
    const programBudgetHistoryVisibility = visibleProgramBudgetRows.map((row) => (
      (scope.canSeeTransactions || canSeeRowDollars(row.serviceCategory)) && directAccess
    ));
    const plannerRenewalPeriods = new Set(
      programBudgetsRaw
        .filter((row) => (
          row.requiredAuthType === "hours"
          && row.programCode !== "CLASSES"
          && programBudgetsRaw
            .filter((candidate) => candidate.budgetPeriodId === row.budgetPeriodId)
            .every((candidate) => candidate.requiredAuthType === "hours" && candidate.programCode !== "CLASSES")
        ))
        .map((row) => row.budgetPeriodId),
    );
    const [programBudgetEvents, programBudgetMonthlyHistory] = await Promise.all([
      Promise.all(
        visibleProgramBudgetRows.map((row, index) => programBudgetHistoryVisibility[index]
          ? listProgramBudgetEvents(pool, row.budgetPeriodId, row.programId)
          : Promise.resolve([])),
      ),
      Promise.all(
        visibleProgramBudgetRows.map((row) => canSeeBudgets && row.requiredAuthType !== "dollars"
          ? listProgramBudgetMonthlyHistory(pool, row.budgetPeriodId, row.programId)
          : Promise.resolve([])),
      ),
    ]);
    const programBudgets = visibleProgramBudgetRows.map((row, index) => ({
      authorizationId: row.authorizationId,
      budgetPeriodId: row.budgetPeriodId,
      programId: row.programId,
      programCode: row.programCode,
      programName: row.programName,
      periodLabel: row.periodLabel,
      startDate: row.startDate,
      endDate: row.endDate,
      renewalDate: row.renewalDate,
      periodType: row.periodType,
      periodStatus: row.periodStatus,
      requiredAuthType: row.requiredAuthType,
      consumptionSource: row.consumptionSource,
      renewalPolicy: row.renewalPolicy,
      isGroupService: row.rateScope === "per_group" || row.serviceCategory === "group_service",
      authorizedHours: canSeeBudgets && row.requiredAuthType !== "dollars" ? row.authorizedHours : null,
      authorizedDollars: canSeeRowDollars(row.serviceCategory) && row.requiredAuthType !== "hours" ? row.authorizedDollars : null,
      internalRate: scope.canSeeEmployeeAmounts && directAccess ? row.internalRate : null,
      agencyRate: canSeeRowDollars(row.serviceCategory) ? row.agencyRate : null,
      individualRateOverride: scope.canSeeEmployeeAmounts && directAccess ? row.individualRateOverride : null,
      allowIndividualRateOverride: row.allowIndividualRateOverride,
      notes: scope.canSeeMoney ? row.notes : null,
      consumedHours: canSeeBudgets && row.requiredAuthType !== "dollars" ? row.consumedHours : null,
      consumedDollars: canSeeRowDollars(row.serviceCategory) && row.requiredAuthType !== "hours" ? row.consumedDollars : null,
      remainingHours: canSeeBudgets && row.requiredAuthType !== "dollars" ? row.remainingHours : null,
      remainingDollars: canSeeRowDollars(row.serviceCategory) && row.requiredAuthType !== "hours" ? row.remainingDollars : null,
      scheduledHours: canSeeBudgets && row.requiredAuthType !== "dollars" ? row.scheduledHours : null,
      remainingAfterScheduledHours: canSeeBudgets && row.requiredAuthType !== "dollars"
        ? row.remainingAfterScheduledHours
        : null,
      // Planners need the budget-quality warning, not a payroll row count.
      undatedUsageCount: scope.canSeeTransactions ? row.undatedUsageCount : null,
      hasUndatedUsage: row.hasUndatedUsage,
      revision: row.revision,
      canManageRenewal: canEdit || (canManageHours && plannerRenewalPeriods.has(row.budgetPeriodId)),
      showEventHistory: programBudgetHistoryVisibility[index] ?? false,
      monthlyHistory: programBudgetMonthlyHistory[index] ?? [],
      events: (programBudgetEvents[index] ?? []).map((event) => ({
        id: event.id,
        eventType: event.eventType,
        serviceDate: event.serviceDate,
        hours: canSeeBudgets && row.requiredAuthType !== "dollars" ? event.hours : null,
        amount: canSeeRowDollars(row.serviceCategory) && row.requiredAuthType !== "hours" ? event.amount : null,
        sourceType: event.sourceType,
        reversesEventId: event.reversesEventId,
        note: scope.canSeeMoney ? event.note : null,
        createdAt: event.createdAt,
      })),
      authorizationRevisions: authorizationHistoryRaw.authorizations
        .filter((authorization) => (
          authorization.budgetPeriodId === row.budgetPeriodId
          && authorization.programId === row.programId
        ))
        .map((authorization) => ({
          id: authorization.id,
          revision: authorization.revision,
          status: authorization.status,
          authorizedHours: canSeeBudgets && row.requiredAuthType !== "dollars"
            ? authorization.authorizedHours
            : null,
          authorizedDollars: canSeeRowDollars(row.serviceCategory) && row.requiredAuthType !== "hours"
            ? authorization.authorizedDollars
            : null,
          internalRate: scope.canSeeEmployeeAmounts && directAccess
            ? authorization.internalRate
            : null,
          agencyRate: canSeeRowDollars(row.serviceCategory)
            ? authorization.agencyRate
            : null,
          individualRateOverride: scope.canSeeEmployeeAmounts && directAccess
            ? authorization.individualRateOverride
            : null,
          notes: scope.canSeeMoney ? authorization.notes : null,
          createdAt: authorization.createdAt,
        })),
    }));
    const operationalBudget = canSeeBudgets
      ? summarizeAuthorizationPortfolio(programBudgetsRaw).get(id)?.budget ?? null
      : null;
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
      individual, budget, operationalBudget, activity: visibleActivity, settlement,
      strategy,
      otherPlans,
      canSeeHours: scope.canSeeHours,
      canSeeBilledAmounts: scope.canSeeBilledAmounts,
      canSeeEmployeeAmounts: scope.canSeeEmployeeAmounts,
      canSeeAgencySpread: scope.canSeeAgencySpread,
      canSeeBudgets,
      canSeeProgramBudgets,
      canSeeSettlements,
      canSeeClasses,
      canManageClasses: scope.canManageClassInvoices,
      canManageHourAuthorizations: canManageHours,
      classBudgets,
      classInvoices,
      programBudgets,
      programCatalog: programCatalogRaw
        .filter((program) => (
          program.isActive
          && program.code !== "CLASSES"
          && (canEdit || program.requiredAuthType === "hours")
        ))
        .map((program) => ({
          id: program.id,
          code: program.code,
          name: program.name,
          requiredAuthType: program.requiredAuthType,
          defaultAgencyRate: scope.canSeeBilledAmounts && directAccess ? program.agencyRate : null,
          defaultInternalRate: scope.canSeeEmployeeAmounts && directAccess ? program.internalRate : null,
          allowIndividualRateOverride: program.allowIndividualRateOverride,
        })),
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
        <ErrorPanel title="Individual profile is unavailable">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();

  const {
    individual, budget, operationalBudget, activity, settlement, strategy, otherPlans,
    canSeeHours, canSeeBilledAmounts, canSeeEmployeeAmounts, canSeeAgencySpread,
    canSeeBudgets, canSeeProgramBudgets,
    canSeeSettlements, canSeeTransactions, canSeeClasses, canManageClasses,
    canManageHourAuthorizations: canManageHours,
    classBudgets, classInvoices, programBudgets, programCatalog,
    programs, assignments, aliases, scheduled,
  } = result.data;
  const operationalHeadline = operationalBudget
    ? BUDGET_STATUS_PRESENT[operationalBudget.plainStatus]
    : null;
  const operationalAuthorized = operationalBudget
    ? dec(operationalBudget.usedHours).plus(operationalBudget.hoursLeft ?? 0)
    : dec(0);

  // Months left until the (rolled) renewal, for the financial plan's remaining pace.
  const monthsToRenewal = budget.daysToRenewal !== null && budget.daysToRenewal > 0 ? budget.daysToRenewal / 30.4375 : null;
  const employeeActivityPeriod = activity.periods.length === 1 ? activity.periods[0] : null;
  const editorLines: BudgetEditorLine[] = budget.lines.map((line) => ({
    programId: line.programId,
    programName: line.programName,
    perHour: canSeeEmployeeAmounts ? line.perHour : "0",
    authorizedHours: line.authorizedHours,
    usedHours: line.usedHours,
    inPlan: line.inPlan,
    daysToRenewal: line.daysToRenewal,
    effectiveRenewal: line.effectiveRenewal,
    calendarYear: line.calendarYear,
  }));
  const editorPrograms = programs.map((program) => ({
    id: program.id,
    code: program.code,
    name: program.name,
    defaultRate: canSeeEmployeeAmounts ? program.internalRate : "0",
  }));
  const canSeeFinancialSetup = canSeeBudgets
    && canSeeBilledAmounts
    && canSeeEmployeeAmounts
    && canSeeAgencySpread;

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
            content: canSeeBudgets && operationalBudget ? (
              <section className="card fade-in-up px-5 py-5" style={{ borderTop: `3px solid ${operationalHeadline?.color ?? "var(--color-primary)"}` }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="eyebrow">Authorized service budget</p>
                    <p className="mt-1 text-2xl font-semibold leading-tight">
                      Used <span className="tnum">{formatHours(operationalBudget.usedHours)}</span> of <span className="tnum">{formatHours(operationalAuthorized.toString())}</span> hours
                    </p>
                    <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                      <span className="tnum font-medium" style={{ color: (operationalBudget.hoursLeft ?? 0) < 0 ? "var(--color-pace-over)" : "var(--color-ink)" }}>
                        {formatHours(operationalBudget.hoursLeft ?? 0)} h {(operationalBudget.hoursLeft ?? 0) < 0 ? "over" : "remaining now"}
                      </span>
                      {" · "}{operationalBudget.missingRenewal
                        ? "One or more renewal dates are missing"
                        : renewLine(true, operationalBudget.daysToRenewal, operationalBudget.renews)}
                    </p>
                    <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                      <span className="tnum font-medium text-[var(--color-ink)]">{formatHours(operationalBudget.scheduledHours)} h scheduled</span>
                      {" · "}
                      <span className="tnum font-medium" style={{ color: (operationalBudget.hoursAfterScheduled ?? 0) < 0 ? "var(--color-pace-over)" : undefined }}>
                        {formatHours(operationalBudget.hoursAfterScheduled ?? 0)} h after schedule
                      </span>
                    </p>
                    {operationalBudget.mustUseMonthly && (operationalBudget.daysToRenewal === null || operationalBudget.daysToRenewal >= 30) ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        Still to plan: <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(operationalBudget.mustUseMonthly)} h/month</span>
                      </p>
                    ) : operationalBudget.daysToRenewal !== null && operationalBudget.daysToRenewal > 0 && operationalBudget.daysToRenewal < 30 && (operationalBudget.hoursAfterScheduled ?? 0) > 0 ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(operationalBudget.hoursAfterScheduled ?? 0)} h</span> still need to be planned for the next {operationalBudget.daysToRenewal} days.
                      </p>
                    ) : null}
                  </div>
                  {operationalHeadline ? <StatusPill status={operationalBudget.plainStatus} /> : null}
                </div>
                <div className="mt-4 max-w-xl">
                  <BudgetBar
                    usagePercent={operationalBudget.usedPct === null ? null : operationalBudget.usedPct / 100}
                    elapsedPercent={operationalBudget.elapsedPct === null ? null : operationalBudget.elapsedPct / 100}
                    color={operationalHeadline?.color ?? "var(--color-pace-on)"}
                  />
                </div>
              </section>
            ) : canSeeBudgets ? (
              <section className="card px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="eyebrow">Budget</p>
                    <p className="mt-1 text-lg font-semibold">No hourly authorization is configured</p>
                    {canSeeTransactions && budget.money.txCount > 0 ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{budget.money.txCount.toLocaleString()} billed transactions are already on file.</p>
                    ) : null}
                  </div>
                  <ButtonLink href={`/individuals/${id}?view=budget`} variant={canEdit ? "primary" : "secondary"}>
                    {canEdit ? "Set up budget" : "Open budget"}
                  </ButtonLink>
                </div>
              </section>
            ) : (
              <section className="card px-5 py-5">
                <p className="eyebrow">Current profile</p>
                <p className="mt-1 text-lg font-semibold">{assignments.length} active employee assignment{assignments.length === 1 ? "" : "s"}</p>
              </section>
            ),
          },
          ...(canSeeProgramBudgets ? [{
            id: "budget",
            label: "Budget",
            badge: programBudgets.length || undefined,
            content: (
              <ProgramBudgetWorkspace
                individualId={id}
                budgets={programBudgets}
                programs={programCatalog}
                canManage={canEdit || canManageHours}
                hoursOnlyManagement={!canEdit && canManageHours}
                showInternalRate={canSeeEmployeeAmounts}
                showAgencyRate={canSeeBilledAmounts}
              />
            ),
          }] : []),
          ...(canSeeClasses ? [{
            id: "classes",
            label: "Classes",
            content: (
              <div className="space-y-5">
                {classBudgets.map((classBudget) => (
                  <section key={classBudget.id} className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="eyebrow">{classBudget.label}</p>
                        <h2 className="mt-1 text-lg font-semibold">{classBudget.startDate} - {classBudget.endDate}</h2>
                      </div>
                      <span className="badge">{classBudget.status === "active" ? "Active" : "Closed"}</span>
                    </div>
                    <div className="mt-5 grid gap-4 border-t border-[var(--color-rule)] pt-4 sm:grid-cols-3">
                      <div><p className="eyebrow">Authorized</p><p className="tnum mt-1 text-xl font-semibold">{formatMoney(classBudget.authorizedAmount)}</p></div>
                      <div><p className="eyebrow">Issued</p><p className="tnum mt-1 text-xl font-semibold">{formatMoney(classBudget.consumedAmount)}</p></div>
                      <div><p className="eyebrow">Remaining</p><p className={`tnum mt-1 text-xl font-semibold ${dec(classBudget.remainingAmount).isNegative() ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(classBudget.remainingAmount)}</p></div>
                    </div>
                  </section>
                ))}

                <Card
                  title="Class invoices"
                  action={canManageClasses ? <ButtonLink href="/classes">Open Classes</ButtonLink> : undefined}
                >
                  {classInvoices.length > 0 ? (
                    <Table head={<><Th>Invoice</Th><Th>Date</Th><Th>Status</Th><Th numeric>Amount</Th><Th numeric>PDF</Th></>}>
                      {classInvoices.map((invoice) => (
                        <Tr key={invoice.id}>
                          <Td><span className="font-semibold">{invoice.invoiceNumber}</span></Td>
                          <Td><span className="tnum">{invoice.invoiceDate}</span></Td>
                          <Td><span className="badge">{invoice.status === "void" ? "Voided" : invoice.status === "issued" ? "Issued" : "Draft"}</span></Td>
                          <Td numeric><Money value={invoice.totalAmount} /></Td>
                          <Td numeric>{invoice.status === "issued" ? <ButtonLink href={`/api/classes/invoices/${invoice.id}/pdf`} variant="secondary">Download</ButtonLink> : null}</Td>
                        </Tr>
                      ))}
                    </Table>
                  ) : (
                    <p className="py-8 text-center text-sm text-[var(--color-ink-faint)]">No class invoices yet.</p>
                  )}
                </Card>
              </div>
            ),
          }] : []),
          ...(canSeeBudgets ? [{
            id: "activity",
            label: "Activity",
            content: (
              <div className="space-y-6">
                {activity.periods.some((period) => period.byProgramMonth.length > 0) ? (
                  <Card
                    title={canSeeTransactions ? "Transaction history" : "Service history"}
                    description="Monthly actual activity in the financial reporting period. Authorization balances remain in Budget."
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
                {activity.byEmployee.length > 0 ? (
                  <Card
                    title="Employees working with this individual"
                    description={canSeeTransactions
                      ? "Employees with billed activity in the current financial reporting period."
                      : "Employees with recorded service activity in the current financial reporting period."}
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
                  <section className="card px-5 py-5 text-sm text-[var(--color-ink-soft)]">No activity is recorded for this reporting period.</section>
                ) : null}
              </div>
            ),
          }] : []),
          ...(canSeeSettlements || (canSeeBudgets && (canSeeBilledAmounts || canSeeEmployeeAmounts) && budget.money.txCount > 0) ? [{
            id: "money",
            label: "Money",
            content: (
              <div className="space-y-6">
                {canSeeBudgets && (canSeeBilledAmounts || canSeeEmployeeAmounts) && budget.money.txCount > 0 ? (
                  <Card
                    title="Transaction money"
                    description="Funder billed and employee base within the current financial reporting period."
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
              </div>
            ),
          }] : []),
          ...(canSeeFinancialSetup && (canEdit || strategy || otherPlans.length > 0) ? [{
            id: "financial",
            label: "Financial setup",
            content: (
              <div className="space-y-6">
                <section className="border-y border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-4">
                  <h2 className="text-base font-semibold text-[var(--color-ink)]">Financial projection assumptions</h2>
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                    Rates, target hours, and cuts here are used only for financial projections. They do not authorize service or change the balances shown in Budget.
                  </p>
                </section>
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
                    canSeeMoney
                  />
                ) : null}
                {strategy && budget.hasPlan ? (
                  <Card
                    title={otherPlans.length > 0 ? `Projection and actuals · ${strategy.label}` : "Projection and actuals"}
                    description="Financial targets compared with actual transactions in this projection period."
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
                {otherPlans.map((plan) => (
                  <section key={plan.strategy.id} className="space-y-4">
                    <p className="eyebrow">Financial projection · {plan.strategy.label}</p>
                    <BudgetEditor
                      individualId={id}
                      strategyId={plan.budget.strategyId}
                      active={plan.budget.active}
                      renewalDate={plan.budget.renewalDate}
                      effectiveRenewal={plan.budget.effectiveRenewal}
                      periodStart={plan.budget.periodStart}
                      periodEnd={plan.budget.periodEnd}
                      lines={plan.budget.lines.map((line) => ({
                        programId: line.programId,
                        programName: line.programName,
                        perHour: canSeeEmployeeAmounts ? line.perHour : "0",
                        authorizedHours: line.authorizedHours,
                        usedHours: line.usedHours,
                        inPlan: line.inPlan,
                        daysToRenewal: line.daysToRenewal,
                        effectiveRenewal: line.effectiveRenewal,
                        calendarYear: line.calendarYear,
                      }))}
                      programs={editorPrograms}
                      canEdit={canEdit}
                      canSeeMoney
                    />
                    {plan.budget.hasPlan ? (
                      <Card title={`Projection and actuals · ${plan.strategy.label}`}>
                        <FinancialPlan
                          strategyId={plan.strategy.id}
                          lines={plan.budget.lines}
                          strategy={plan.strategy}
                          timeElapsedPercent={plan.budget.timeElapsedPercent}
                          monthsToRenewal={plan.budget.daysToRenewal !== null && plan.budget.daysToRenewal > 0 ? plan.budget.daysToRenewal / 30.4375 : null}
                          canManage={canEdit}
                        />
                      </Card>
                    ) : null}
                  </section>
                ))}
                {canEdit && strategy ? <AddPlanButton individualId={id} nextLabel={String(otherPlans.length + 2)} /> : null}
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

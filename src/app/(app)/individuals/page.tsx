import { hasPortalCapability, resolvePortalAccess } from "@/lib/auth/portal-access";
import { listIndividualOperationalReviews } from "@/lib/data/operational-review";
import { requireUser } from "@/lib/auth/session";
import { canAccessPlanning, hasDirectIndividualAccess, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listIndividualBudgetBoard } from "@/lib/data/queries";
import { listCurrentProgramBudgets, listProgramBudgets } from "@/lib/data/program-budgets";
import { summarizeAuthorizationPortfolio } from "@/lib/data/authorization-portfolio";
import { Card, EmptyState, ErrorPanel, PageHeader, ButtonLink } from "@/components/ui";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import BudgetStatusWorkspace from "@/components/individuals/budget-status-workspace";
import { agencyDate } from "@/lib/business/agency-time";
import { resolvePortfolioView } from "@/components/individuals/portfolio-view";
import { resolveBudgetStatusView } from "@/components/individuals/budget-status-view";
import { getIndividualPortfolioStaffingContext } from "@/lib/data/individual-profile";
import { buildUpToDateBudgetPortfolio } from "@/lib/business/up-to-date-budget";
import { listIndividualResponsibilities } from "@/lib/manage/operational-responsibility";
import { isWorkingProgram } from "@/lib/business/working-programs";

export const dynamic = "force-dynamic";
export const metadata = { title: "People - Ahivim Budget Management" };

/** The create/edit form shares one field set. */
function individualFields() {
  return (
    <>
      <Field label="Name" name="displayName" required help="How this person is shown throughout Ahivim." />
      <Field label="Legal name" name="legalName" help="Defaults to the display name if left blank." />
      <Field label="Preferred name" name="preferredName" />
      <Field label="External reference" name="externalRef" help="An agency or case number, if there is one." />
      <TextAreaField label="Notes" name="notes" />
    </>
  );
}

export default async function IndividualsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, sp] = await Promise.all([
    requireUser("viewer"),
    searchParams,
  ]);
  const canEdit = user.role !== "viewer";
  const requestedView = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const requestedBudget = Array.isArray(sp.budget) ? sp.budget[0] : sp.budget;
  const requestedSheet = Array.isArray(sp.sheet) ? sp.sheet[0] : sp.sheet;
  const initialView = resolvePortfolioView({ view: requestedView, budget: requestedBudget });
  const initialSheet = resolveBudgetStatusView(requestedSheet);
  const showAllPrograms = sp.programScope === "all";
  const scopeParams = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) if (key !== "programScope" && value !== undefined) {
    for (const item of Array.isArray(value) ? value : [value]) scopeParams.append(key, item);
  }
  if (!showAllPrograms) scopeParams.set("programScope", "all");
  const scopeHref = `/individuals${scopeParams.size ? `?${scopeParams}` : ""}`;

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const today = agencyDate();
    const asOf = new Date(`${today}T12:00:00Z`);
    const canManageResponsibility = hasPortalCapability(await resolvePortalAccess(pool, user), "agencies.manage");
    const reviews = canManageResponsibility ? await listIndividualOperationalReviews(pool, today) : new Map();
    const canPlan = canAccessPlanning(scope);
    const canViewUpToDate = scope.canSeeBudgets && scope.canSeeHours;
    const [rows, authorizationRows, explicitAuthorizationRows, staffingContext] = await Promise.all([
      listIndividualBudgetBoard(pool, asOf, scope),
      canViewUpToDate
        ? listCurrentProgramBudgets(pool, { asOf: today, scope })
        : Promise.resolve([]),
      canViewUpToDate
        ? listProgramBudgets(pool, { scope })
        : Promise.resolve([]),
      getIndividualPortfolioStaffingContext(pool, scope, {
        canViewPlanning: canPlan,
        from: today,
      }),
    ]);
    const visibleIds = new Set(rows.map((row) => row.id));
    const responsibilities = canViewUpToDate ? await listIndividualResponsibilities(pool, today) : new Map();
    const memberships = canViewUpToDate ? await pool.query<{ individual_id: string; program_id: string; program_code: string; program_name: string }>(
      `SELECT DISTINCT relation.individual_id, program.id AS program_id, program.code AS program_code, program.name AS program_name
       FROM (SELECT individual_id, program_id FROM payroll_transactions WHERE individual_id = ANY($1::uuid[])
         UNION SELECT strategy.individual_id, line.program_id FROM calculation_strategies strategy
           JOIN calculation_strategy_lines line ON line.strategy_id = strategy.id WHERE strategy.individual_id = ANY($1::uuid[])
         UNION SELECT individual_id, program_id FROM program_budget_balances WHERE individual_id = ANY($1::uuid[])) relation
       JOIN programs program ON program.id = relation.program_id`, [[...visibleIds]]) : { rows: [] };
    const workingMemberships = memberships.rows.filter((row) => isWorkingProgram({ programId: row.program_id, programCode: row.program_code }, responsibilities.get(row.individual_id)));
    const workingPeople = new Set([...workingMemberships.map((row) => row.individual_id), ...authorizationRows.filter((row) => isWorkingProgram(row, responsibilities.get(row.individualId))).map((row) => row.individualId)]);
    const isVisibleProgram = (row: (typeof authorizationRows)[number]) => visibleIds.has(row.individualId)
      && (showAllPrograms || isWorkingProgram(row, responsibilities.get(row.individualId)));
    const visibleAuthorizationRows = authorizationRows.filter(isVisibleProgram);
    const visibleExplicitAuthorizationRows = explicitAuthorizationRows.filter(isVisibleProgram);
    const authorizationPortfolio = summarizeAuthorizationPortfolio(
      visibleAuthorizationRows,
      asOf,
    );
    const canonicalBudgetPeople = new Set(
      visibleAuthorizationRows
        .filter((row) => row.requiredAuthType === "hours" || row.requiredAuthType === "both")
        .map((row) => row.individualId),
    );
    const people = rows.filter((row) => !canViewUpToDate || showAllPrograms || workingPeople.has(row.id)).map((row) => {
      const staffing = staffingContext.get(row.id);
      const nextSession = staffing?.nextSession ?? null;
      const staffingFacts = {
        operationalReview: reviews.get(row.id),
        staffingVisible: canPlan,
        canPlan,
        assignedEmployees: staffing?.assignedEmployees ?? [],
        nextScheduledService: nextSession ? {
          id: nextSession.id,
          date: nextSession.sessionDate,
          startTime: nextSession.startTime,
          programName: nextSession.programName,
          employeeId: nextSession.employeeId,
          employeeName: nextSession.employeeName,
        } : null,
      };
      return (
      scope.canSeeBudgets && scope.canSeeHours && hasDirectIndividualAccess(scope, row.id)
        ? {
            ...row,
            ...staffingFacts,
            programs: [...new Set([
              ...(showAllPrograms ? row.programs : workingMemberships.filter((membership) => membership.individual_id === row.id).map((membership) => membership.program_name)),
              ...(authorizationPortfolio.get(row.id)?.programs ?? []),
            ])].sort(),
            budget: (() => {
              const canonical = authorizationPortfolio.get(row.id)?.budget;
              const budget = canonical ? {
                ...canonical,
                transactionCount: row.budget?.transactionCount ?? 0,
              } : null;
              return budget ? {
                ...budget,
                transactionCount: scope.canSeeTransactions ? budget.transactionCount : null,
                billedAmount: scope.canSeeBilledAmounts ? budget.billedAmount : null,
              } : null;
            })(),
            hasCanonicalBudget: canonicalBudgetPeople.has(row.id),
            insightsVisible: true,
          }
        : {
            ...row,
            ...staffingFacts,
            programs: [],
            budget: null,
            hasCanonicalBudget: false,
            hasBilling: false,
            lastBilledOn: null,
            insightsVisible: false,
          }
      );
    });
    return {
      people,
      canViewUpToDate,
      upToDate: buildUpToDateBudgetPortfolio({
        current: visibleAuthorizationRows,
        explicit: visibleExplicitAuthorizationRows,
        asOf: today,
      }),
    };
  });

  return (
    <>
      <PageHeader
        eyebrow="Budgets"
        title="People"
        description="See each person's renewal date, remaining hours, and monthly plan."
        action={
          canEdit ? (
            <CreateButton label="Add person" title="Add a person" endpoint="/api/individuals" fields={individualFields()} />
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--color-rule)] p-3 text-sm">
        <p>{showAllPrograms ? "All authorized program relationships are shown. Totals cover the displayed scope." : "Working scope: Self-Hired ComHab, Self-Hired Respite, and other programs explicitly managed by us. Totals cover these programs."}</p>
        <ButtonLink href={scopeHref}>{showAllPrograms ? "Show working programs" : "Show all programs / all individuals"}</ButtonLink>
      </div>

      {!result.ok ? (
        <ErrorPanel title="Budget list is unavailable">{result.error} <ButtonLink href="/individuals">Try again</ButtonLink></ErrorPanel>
      ) : result.data.people.length === 0 ? (
        <Card>
          <EmptyState title={showAllPrograms ? "No people yet" : "No people in the working program scope"}>
            <p>{showAllPrograms ? "People appear here after billing data is added." : "Use Show all programs / all individuals to find people for setup."}</p>
          </EmptyState>
        </Card>
      ) : (
        <BudgetStatusWorkspace
          rows={result.data.people}
          upToDate={result.data.upToDate}
          initialView={initialSheet}
          initialFilter={initialView}
          canManage={canEdit}
          canViewUpToDate={result.data.canViewUpToDate}
        />
      )}
    </>
  );
}

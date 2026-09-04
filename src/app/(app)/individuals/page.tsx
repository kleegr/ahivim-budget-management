import { requireUser } from "@/lib/auth/session";
import { canAccessPlanning, hasDirectIndividualAccess, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listIndividualBudgetBoard } from "@/lib/data/queries";
import { listCurrentProgramBudgets, listProgramBudgets } from "@/lib/data/program-budgets";
import { summarizeAuthorizationPortfolio } from "@/lib/data/authorization-portfolio";
import { Card, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import BudgetStatusWorkspace from "@/components/individuals/budget-status-workspace";
import { agencyDate } from "@/lib/business/agency-time";
import { resolvePortfolioView } from "@/components/individuals/portfolio-view";
import { resolveBudgetStatusView } from "@/components/individuals/budget-status-view";
import { getIndividualPortfolioStaffingContext } from "@/lib/data/individual-profile";
import { buildUpToDateBudgetPortfolio } from "@/lib/business/up-to-date-budget";

export const dynamic = "force-dynamic";
export const metadata = { title: "People & budgets - Ahivim Budget Management" };

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

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const today = agencyDate();
    const asOf = new Date(`${today}T12:00:00Z`);
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
    const visibleAuthorizationRows = authorizationRows.filter((row) => visibleIds.has(row.individualId));
    const visibleExplicitAuthorizationRows = explicitAuthorizationRows.filter((row) => visibleIds.has(row.individualId));
    const authorizationPortfolio = summarizeAuthorizationPortfolio(
      visibleAuthorizationRows,
      asOf,
    );
    const canonicalBudgetPeople = new Set(
      visibleAuthorizationRows
        .filter((row) => row.requiredAuthType === "hours" || row.requiredAuthType === "both")
        .map((row) => row.individualId),
    );
    const people = rows.map((row) => {
      const staffing = staffingContext.get(row.id);
      const nextSession = staffing?.nextSession ?? null;
      const staffingFacts = {
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
              ...row.programs,
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
        title="People & budgets"
        description="See each person's renewal date, remaining hours, and monthly plan."
        action={
          canEdit ? (
            <CreateButton label="Add person" title="Add a person" endpoint="/api/individuals" fields={individualFields()} />
          ) : undefined
        }
      />

      {!result.ok ? (
        <ErrorPanel title="Budget list is unavailable">{result.error}</ErrorPanel>
      ) : result.data.people.length === 0 ? (
        <Card>
          <EmptyState title="No people yet">
            <p>People appear here after billing data is added{canEdit ? ", or you can add someone with the Add person button." : "."}</p>
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

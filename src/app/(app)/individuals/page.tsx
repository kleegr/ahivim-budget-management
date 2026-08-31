import { requireUser } from "@/lib/auth/session";
import { hasDirectIndividualAccess, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listIndividualBudgetBoard } from "@/lib/data/queries";
import { listProgramBudgets } from "@/lib/data/program-budgets";
import { summarizeAuthorizationPortfolio } from "@/lib/data/authorization-portfolio";
import { Card, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import IndividualsList from "@/components/individuals/individuals-list";
import { agencyDate } from "@/lib/business/agency-time";
import { resolvePortfolioView } from "@/components/individuals/portfolio-view";

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
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const sp = await searchParams;
  const requestedView = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const requestedBudget = Array.isArray(sp.budget) ? sp.budget[0] : sp.budget;
  const initialView = resolvePortfolioView({ view: requestedView, budget: requestedBudget });

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const today = agencyDate();
    const asOf = new Date(`${today}T12:00:00Z`);
    const [rows, authorizationRows] = await Promise.all([
      listIndividualBudgetBoard(pool, asOf, scope),
      scope.canSeeBudgets
        ? listProgramBudgets(pool, { status: "active", asOf: today })
        : Promise.resolve([]),
    ]);
    const visibleIds = new Set(rows.map((row) => row.id));
    const authorizationPortfolio = summarizeAuthorizationPortfolio(
      authorizationRows.filter((row) => visibleIds.has(row.individualId)),
      asOf,
    );
    return rows.map((row) => (
      scope.canSeeBudgets && scope.canSeeHours && hasDirectIndividualAccess(scope, row.id)
        ? {
            ...row,
            programs: [...new Set([
              ...row.programs,
              ...(authorizationPortfolio.get(row.id)?.programs ?? []),
            ])].sort(),
            budget: (() => {
              const canonical = authorizationPortfolio.get(row.id)?.budget;
              const budget = canonical
                ? {
                    ...canonical,
                    transactionCount: row.budget?.transactionCount ?? 0,
                  }
                : row.budget;
              return budget ? {
                ...budget,
                transactionCount: scope.canSeeTransactions ? budget.transactionCount : null,
                billedAmount: scope.canSeeBilledAmounts ? budget.billedAmount : null,
              } : null;
            })(),
            insightsVisible: true,
          }
        : { ...row, programs: [], budget: null, hasBilling: false, lastBilledOn: null, insightsVisible: false }
    ));
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
      ) : result.data.length === 0 ? (
        <Card>
          <EmptyState title="No people yet">
            <p>People appear here after billing data is added{canEdit ? ", or you can add someone with the Add person button." : "."}</p>
          </EmptyState>
        </Card>
      ) : (
        <IndividualsList key={initialView} rows={result.data} initialFilter={initialView} />
      )}
    </>
  );
}

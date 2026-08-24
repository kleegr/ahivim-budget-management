import { requireUser } from "@/lib/auth/session";
import { hasDirectIndividualAccess, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listIndividualBudgetBoard } from "@/lib/data/queries";
import { Card, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import IndividualsList from "@/components/individuals/individuals-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individuals — Ahivim Budget Management" };

/** The create/edit form shares one field set. */
function individualFields() {
  return (
    <>
      <Field label="Display name" name="displayName" required help="How this person is shown everywhere." />
      <Field label="Renewal date" name="renewalDate" type="date" help="The budget's yearly renewal. It auto-rolls forward each year while the account is active. You can add programs and hours on the profile next." />
      <Field label="Legal name" name="legalName" help="Defaults to the display name if left blank." />
      <Field label="Preferred name" name="preferredName" />
      <Field label="External reference" name="externalRef" help="An agency or case number, if there is one." />
      <TextAreaField label="Notes" name="notes" />
    </>
  );
}

export default async function IndividualsPage() {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const rows = await listIndividualBudgetBoard(pool, new Date(), scope);
    return rows.map((row) => (
      scope.canSeeBudgets && scope.canSeeHours && hasDirectIndividualAccess(scope, row.id)
        ? { ...row, insightsVisible: true }
        : { ...row, programs: [], budget: null, hasBilling: false, insightsVisible: false }
    ));
  });

  return (
    <>
      <PageHeader
        eyebrow="Budgets"
        title="Individuals"
        description="See who is over authorization, falling behind pace, nearing renewal, or missing the budget needed to explain billing."
        action={
          canEdit ? (
            <CreateButton label="New individual" title="New individual" endpoint="/api/individuals" fields={individualFields()} />
          ) : undefined
        }
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load individuals">{result.error}</ErrorPanel>
      ) : result.data.length === 0 ? (
        <Card>
          <EmptyState title="No individuals yet">
            <p>Individuals appear here once a workbook is committed{canEdit ? ", or add one with the New individual button." : "."}</p>
          </EmptyState>
        </Card>
      ) : (
        <IndividualsList rows={result.data} />
      )}
    </>
  );
}

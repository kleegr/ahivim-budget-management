import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listEmployeesManaged } from "@/lib/manage/employees";
import { Card, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import EmployeesList, { type EmployeeRow } from "@/components/employees/employees-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employees — Ahivim Budget Management" };

/** The create/edit form shares one field set. */
function employeeFields() {
  return (
    <>
      <Field label="Display name" name="displayName" required help="How this employee is shown everywhere." />
      <Field label="External reference" name="externalRef" help="A payroll or staff number, if there is one." />
      <TextAreaField label="Notes" name="notes" />
    </>
  );
}

export default async function EmployeesPage() {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";

  const result = await withDb((pool) => listEmployeesManaged(pool, { includeArchived: true }));

  return (
    <>
      <PageHeader
        eyebrow="Register"
        title="Employees"
        description="Everyone who delivers services. Search or sort live, and open a record to see hours, the individuals they serve, and recent transactions."
        action={
          canEdit ? (
            <CreateButton label="New employee" title="New employee" endpoint="/api/employees" fields={employeeFields()} />
          ) : undefined
        }
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load employees">{result.error}</ErrorPanel>
      ) : result.data.length === 0 ? (
        <Card>
          <EmptyState title="No employees yet">
            <p>Employees appear here once a workbook is committed{canEdit ? ", or add one with “New employee”." : "."}</p>
          </EmptyState>
        </Card>
      ) : (
        <EmployeesList
          rows={result.data.map<EmployeeRow>((r) => ({
            id: r.id,
            name: r.displayName,
            externalRef: r.externalRef,
            status: r.status,
            archived: r.status === "archived" || r.archivedAt !== null,
          }))}
          canEdit={canEdit}
        />
      )}
    </>
  );
}

import { requireUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listEmployeeDirectory } from "@/lib/data/employee-directory";
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

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    if (isPlanningOnlyAccess(scope)) return { planningOnly: true as const, rows: [] };
    return { planningOnly: false as const, rows: await listEmployeeDirectory(pool, scope) };
  });
  if (result.ok && result.data.planningOnly) redirect("/schedule");

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Employees"
        description="Find employees, see recent activity, and open a profile."
        action={
          canEdit ? (
            <CreateButton label="New employee" title="New employee" endpoint="/api/employees" fields={employeeFields()} />
          ) : undefined
        }
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load employees">{result.error}</ErrorPanel>
      ) : result.data.rows.length === 0 ? (
        <Card>
          <EmptyState title="No employees yet">
            <p>Employees appear here once a workbook is committed{canEdit ? ", or add one with “New employee”." : "."}</p>
          </EmptyState>
        </Card>
      ) : (
        <EmployeesList
          rows={result.data.rows.map<EmployeeRow>((r) => ({
            id: r.id,
            name: r.displayName,
            externalRef: r.externalRef,
            status: r.status,
            archived: r.status === "archived" || r.archivedAt !== null,
            transactionCount: r.transactionCount,
            checkCount: r.checkCount,
            billedHours: r.billedHours,
            individualsServed: r.individualsServed,
            lastActivityDate: r.lastActivityDate,
            dealReadiness: r.dealReadiness,
            missingDealTransactions: r.missingDealTransactions,
            openSettlementItems: r.openSettlementItems,
          }))}
          canEdit={canEdit}
        />
      )}
    </>
  );
}

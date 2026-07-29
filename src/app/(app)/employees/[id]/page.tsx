import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getEmployeeReport } from "@/lib/data/queries";
import { isUuid, listTransactions, listPrograms } from "@/lib/data/app-queries";
import { getEmployee } from "@/lib/manage/employees";
import { listAssignments } from "@/lib/manage/assignments";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import {
  Card, Table, Th, Td, Tr, Money, Hours, Plain, Badge, EmptyState, ErrorPanel, PageHeader, StatTile, ButtonLink,
} from "@/components/ui";
import { CreateButton, ActionButton, Field, TextAreaField, SelectField } from "@/components/manage/client";
import { formatHours, formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employee — Ahivim Budget Management" };

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await withDb(async (pool) => {
    const employee = await getEmployee(pool, id);
    if (!employee) return null;
    const [report, assignments, recent, programs, individuals] = await Promise.all([
      getEmployeeReport(pool, id),
      listAssignments(pool, { employeeId: id, includeInactive: true }),
      listTransactions(pool, { employeeId: id, limit: 25 }),
      listPrograms(pool),
      listIndividualsManaged(pool, { status: "active" }),
    ]);
    return { employee, report, assignments, recent, programs, individuals };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Employee" title="Employee" />
        <ErrorPanel title="Could not load this employee">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();

  const { employee, report, assignments, recent, programs, individuals } = result.data;

  const programOptions = programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }));
  const individualOptions = individuals.map((i) => ({ value: i.id, label: i.displayName }));

  const editEmployee = canEdit ? (
    <CreateButton
      label="Edit"
      title="Edit employee"
      endpoint={`/api/employees/${id}`}
      method="PATCH"
      variant="secondary"
      fields={
        <>
          <Field label="Display name" name="displayName" defaultValue={employee.displayName} required />
          <Field label="External reference" name="externalRef" defaultValue={employee.externalRef} />
          <TextAreaField label="Notes" name="notes" defaultValue={employee.notes} />
        </>
      }
    />
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow="Employee"
        title={employee.displayName}
        description={
          report && report.programs.length
            ? `Programs: ${report.programs.join(", ")}`
            : "No programs recorded yet."
        }
        action={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              {editEmployee}
              {employee.status === "active" ? (
                <>
                  <ActionButton label="Deactivate" endpoint={`/api/employees/${id}`} body={{ action: "deactivate" }} withReason />
                  <ActionButton label="Archive" endpoint={`/api/employees/${id}`} body={{ action: "archive" }} withReason />
                </>
              ) : (
                <ActionButton label="Restore" endpoint={`/api/employees/${id}`} body={{ action: "restore" }} withReason variant="primary" />
              )}
            </div>
          ) : (
            <ButtonLink href="/employees">All employees</ButtonLink>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <Badge value={employee.status} />
        {employee.externalRef ? (
          <span className="text-[var(--color-ink-faint)]">Ref: {employee.externalRef}</span>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Physical vs allocation hours: two different quantities, never    */}
      {/* merged. See the note below the tiles.                            */}
      {/* ---------------------------------------------------------------- */}
      {report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Physical hours"
              value={`${formatHours(report.physicalHours)} h`}
              hint="Time present; a group session counts once"
            />
            <StatTile
              label="Allocation hours"
              value={`${formatHours(report.allocationHours)} h`}
              hint="Sum of each individual's entitlement"
            />
            <StatTile
              label="Individuals served"
              value={report.individualsServed.toLocaleString()}
              hint={`${report.groupSessions.toLocaleString()} group sessions`}
            />
            <StatTile
              label="Agency gross"
              value={formatMoney(report.agencyGross)}
              hint={`Estimated internal ${formatMoney(report.internalAmount)}`}
            />
          </div>

          <p className="mt-3 max-w-prose text-xs text-[var(--color-ink-faint)]">
            Physical and allocation hours are deliberately separate. A 13-hour session with three
            individuals is 13 physical hours and 39 allocation hours; reporting 39 as hours worked
            would overstate this employee&rsquo;s time threefold.
          </p>

          {report.rateExceptions > 0 ? (
            <div className="mt-4">
              <ErrorPanel title={`${report.rateExceptions} rate exceptions on this employee's rows`}>
                <p>The imported rates were preserved exactly. See Exceptions for the full list.</p>
              </ErrorPanel>
            </div>
          ) : null}
        </>
      ) : (
        <Card>
          <EmptyState title="No activity recorded">
            <p>This employee has no transactions yet, so there are no hours to report.</p>
          </EmptyState>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Notes                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card title="Notes">
          <p className="px-5 py-4 text-sm whitespace-pre-wrap">
            {employee.notes ? (
              employee.notes
            ) : (
              <span className="text-[var(--color-ink-faint)]">
                No notes recorded.{canEdit ? " Use “Edit” to add some." : ""}
              </span>
            )}
          </p>
        </Card>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Assignments — the individuals this employee may serve            */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card
          title="Assignments"
          description="Individuals this employee is permitted to serve. An employee may serve more than one individual."
          action={
            canEdit ? (
              <CreateButton
                label="Assign individual"
                title="Assign individual"
                endpoint="/api/assignments"
                size="sm"
                hidden={{ employeeId: id }}
                fields={
                  <>
                    <SelectField
                      label="Individual"
                      name="individualId"
                      required
                      options={individualOptions}
                      placeholder="Choose an individual"
                    />
                    <SelectField label="Program" name="programId" options={programOptions} placeholder="Any program" />
                    <Field label="Start date" name="startDate" type="date" />
                    <Field label="End date" name="endDate" type="date" />
                    <Field label="Allowed hours" name="allowedHours" type="number" />
                    <TextAreaField label="Notes" name="notes" />
                  </>
                }
              />
            ) : undefined
          }
        >
          {assignments.length === 0 ? (
            <EmptyState title="No individuals assigned">
              <p>
                This employee is not yet permitted to serve anyone.
                {canEdit ? " Use “Assign individual” to add one." : ""}
              </p>
            </EmptyState>
          ) : (
            <Table
              caption="Individuals this employee may serve"
              head={
                <>
                  <Th>Individual</Th>
                  <Th>Program</Th>
                  <Th>Dates</Th>
                  <Th numeric>Allowed hours</Th>
                  <Th>Status</Th>
                  {canEdit ? <Th>Actions</Th> : null}
                </>
              }
            >
              {assignments.map((a) => (
                <Tr key={a.id}>
                  <Td>
                    <Link className="underline underline-offset-2" href={`/individuals/${a.individualId}`}>
                      {a.individualName}
                    </Link>
                  </Td>
                  <Td>
                    <Plain value={a.programName} />
                  </Td>
                  <Td>
                    <span className="tnum">{a.startDate ?? "—"}</span>
                    <span className="text-[var(--color-ink-faint)]"> → </span>
                    <span className="tnum">{a.endDate ?? "open"}</span>
                  </Td>
                  <Td numeric>
                    <Hours value={a.allowedHours} />
                  </Td>
                  <Td>
                    <Badge value={a.status} />
                  </Td>
                  {canEdit ? (
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        {a.status === "active" ? (
                          <ActionButton label="End" endpoint={`/api/assignments/${a.id}`} body={{ action: "end" }} withReason />
                        ) : null}
                        {a.status !== "archived" ? (
                          <ActionButton label="Archive" endpoint={`/api/assignments/${a.id}`} body={{ action: "archive" }} withReason />
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Recent transactions (preserved from the report)                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card title="Recent transactions" description="Most recent 25 rows for this employee">
          {recent.rows.length === 0 ? (
            <EmptyState title="No transactions recorded" />
          ) : (
            <Table
              caption="Recent transactions for this employee"
              head={<><Th>Check</Th><Th>Individual</Th><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Rate</Th><Th numeric>Amount</Th><Th>Group</Th></>}
            >
              {recent.rows.map((t) => (
                <Tr key={t.id}>
                  <Td>
                    <Plain value={t.checkNumber} />
                    <p className="text-xs text-[var(--color-ink-faint)]"><Plain value={t.checkDate} /></p>
                  </Td>
                  <Td><Plain value={t.individual} /></Td>
                  <Td><Plain value={t.program} /></Td>
                  <Td numeric><Hours value={t.hours} /></Td>
                  <Td numeric><Money value={t.rate} /></Td>
                  <Td numeric><Money value={t.amount} /></Td>
                  <Td>{t.isGroup ? <Badge value="valid" label="group" /> : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

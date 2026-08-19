import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getEmployeeReport } from "@/lib/data/queries";
import { isUuid, listTransactions } from "@/lib/data/app-queries";
import {
  getEmployeePaymentSummary,
  getEmployeeIndividuals,
  getEmployeeUsageByProgram,
  getEmployeeMonthlyPayments,
  getEmployeeSchedule,
} from "@/lib/data/employee-queries";
import { txLink } from "@/lib/nav/tx-link";
import { getEmployee } from "@/lib/manage/employees";
import { listAssignments } from "@/lib/manage/assignments";
import {
  Card, Table, Th, Td, Tr, Money, Hours, Plain, ErrorPanel, PageHeader, ButtonLink,
} from "@/components/ui";
import { CreateButton, ActionButton, Field, TextAreaField } from "@/components/manage/client";
import { dec, formatHours, formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employee — Ahivim Budget Management" };

/*
  The employee profile, simplified to answer: what did this person do, and how
  much money did it make? It opens with a plain summary and the money, then who
  they served and which programs — the two tables a coordinator actually reads.
  Everything deeper (recent rows, who they're allowed to serve, the schedule, the
  month-by-month payment breakdown) is folded into "More details" and hidden when
  empty, so a first-time reader is never buried.
*/

function MoneyTile({ label, value, sub, plain }: { label: string; value: string; sub?: string; plain?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-2.5">
      <p className="eyebrow text-[var(--color-text-soft)]">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${plain ? "" : "tnum"}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{sub}</p> : null}
    </div>
  );
}

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await withDb(async (pool) => {
    const employee = await getEmployee(pool, id);
    if (!employee) return null;
    const [report, assignments, recent, payment, individualsServed, usageByProgram, monthly, schedule] = await Promise.all([
      getEmployeeReport(pool, id),
      listAssignments(pool, { employeeId: id, includeInactive: true }),
      listTransactions(pool, { employeeId: id, limit: 25 }),
      getEmployeePaymentSummary(pool, id),
      getEmployeeIndividuals(pool, id),
      getEmployeeUsageByProgram(pool, id),
      getEmployeeMonthlyPayments(pool, id),
      getEmployeeSchedule(pool, id),
    ]);
    return { employee, report, assignments: assignments.filter((a) => a.status === "active"), recent, payment, individualsServed, usageByProgram, monthly, schedule };
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

  const { employee, report, assignments, recent, payment, individualsServed, usageByProgram, monthly, schedule } = result.data;
  const attributionAvailable = payment.transactionCount === 0 || payment.attributedCount > 0;

  const headerActions = canEdit ? (
    <div className="flex flex-wrap gap-2">
      <CreateButton
        label="Edit"
        title="Edit employee"
        endpoint={`/api/employees/${id}`}
        method="PATCH"
        variant="secondary"
        fields={
          <>
            <Field label="Display name" name="displayName" defaultValue={employee.displayName} required />
            <TextAreaField label="Notes" name="notes" defaultValue={employee.notes} />
          </>
        }
      />
      {employee.status === "active" ? (
        <ActionButton label="Archive" endpoint={`/api/employees/${id}`} body={{ action: "archive" }} withReason />
      ) : (
        <ActionButton label="Restore" endpoint={`/api/employees/${id}`} body={{ action: "restore" }} withReason variant="primary" />
      )}
    </div>
  ) : (
    <ButtonLink href="/employees">All employees</ButtonLink>
  );

  const hasActivity = !!report && report.individualsServed > 0;

  return (
    <>
      <PageHeader eyebrow="Employee" title={employee.displayName} action={headerActions} />

      {/* ---- The plain summary ---- */}
      {hasActivity && report ? (
        <section className="card fade-in-up mb-6 px-5 py-5">
          <p className="eyebrow">What this employee has done</p>
          <p className="mt-1 text-2xl font-semibold leading-tight">
            Billed <span className="tnum">{formatHours(report.allocationHours)}</span> hours for{" "}
            <span className="tnum">{report.individualsServed}</span> {report.individualsServed === 1 ? "person" : "people"}
          </p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Across {report.programs.length} program{report.programs.length === 1 ? "" : "s"}
            {report.programs.length ? `: ${report.programs.join(", ")}` : ""}
            {report.groupSessions > 0 ? ` · ${report.groupSessions.toLocaleString()} group sessions` : ""}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <MoneyTile label="Agency total (billed)" value={formatMoney(report.agencyGross)} sub="what the funder paid" />
            <MoneyTile label="Employee earned" value={formatMoney(report.internalAmount)} sub="owed to this employee" />
            <MoneyTile label="Agency difference" value={formatMoney(payment.agencyAdditional)} sub="agency total above the employee amount" />
          </div>
        </section>
      ) : (
        <section className="card mb-6 px-5 py-5">
          <p className="text-lg font-semibold">No billed activity yet</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Once this employee has transactions, their hours, people served and pay appear here.</p>
        </section>
      )}

      {/* ---- Who they served ---- */}
      {individualsServed.length > 0 ? (
        <Card title="People served" description="Everyone this employee billed for. Click a name to open their budget, or the rows to see the transactions." className="mb-6">
          <Table head={<><Th>Person</Th><Th numeric>Billed hours</Th><Th numeric>Transactions</Th><Th numeric>Agency total</Th><Th>Open</Th></>}>
            {individualsServed.map((row) => (
              <Tr key={row.id}>
                <Td><Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${row.id}`}>{row.displayName}</Link></Td>
                <Td numeric><Hours value={row.allocationHours} /></Td>
                <Td numeric className="tnum">{row.transactionCount}</Td>
                <Td numeric><Money value={row.agencyGross} /></Td>
                <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, individualId: row.id })}>rows →</Link></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {/* ---- By program ---- */}
      {usageByProgram.length > 0 ? (
        <Card title="Billed by program" description="Hours and money for each program, straight from the ledger." className="mb-6"
          action={<ButtonLink href={txLink({ employeeId: id })} variant="secondary">All rows →</ButtonLink>}>
          <Table head={<><Th>Program</Th><Th numeric>Billed hours</Th><Th numeric>Transactions</Th><Th numeric>Agency total</Th><Th numeric>Employee amount</Th><Th>Open</Th></>}>
            {usageByProgram.map((row) => (
              <Tr key={row.programCode}>
                <Td><Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={txLink({ employeeId: id, program: row.programName })}>{row.programName}</Link></Td>
                <Td numeric><Hours value={row.allocationHours} /></Td>
                <Td numeric className="tnum">{row.transactionCount}</Td>
                <Td numeric><Money value={row.agencyGross} /></Td>
                <Td numeric><Money value={row.internalAmount} /></Td>
                <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, program: row.programName })}>rows →</Link></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {/* ---- Everything else, folded away ---- */}
      <MoreDetails
        id={id}
        recent={recent}
        assignments={assignments}
        schedule={schedule}
        monthly={monthly}
        attributionAvailable={attributionAvailable}
        rateExceptions={report?.rateExceptions ?? 0}
        physicalHours={report?.physicalHours ?? "0"}
        billedHours={report?.allocationHours ?? "0"}
        notes={employee.notes}
      />
    </>
  );
}

/* ------------------------------------------------------------- collapsed */

function MoreDetails({
  id, recent, assignments, schedule, monthly, attributionAvailable, rateExceptions, physicalHours, billedHours, notes,
}: {
  id: string;
  recent: Awaited<ReturnType<typeof listTransactions>>;
  assignments: Awaited<ReturnType<typeof listAssignments>>;
  schedule: Awaited<ReturnType<typeof getEmployeeSchedule>>;
  monthly: Awaited<ReturnType<typeof getEmployeeMonthlyPayments>>;
  attributionAvailable: boolean;
  rateExceptions: number;
  physicalHours: string;
  billedHours: string;
  notes: string | null;
}) {
  const hasPending = schedule.summary.pendingSessions > 0;
  const groupGap = dec(billedHours).greaterThan(dec(physicalHours));
  const hasAnything =
    recent.rows.length > 0 || assignments.length > 0 || hasPending || monthly.length > 0 || rateExceptions > 0 || groupGap || !!notes;
  if (!hasAnything) return null;

  return (
    <details className="card px-5 py-4">
      <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">More details</summary>
      <div className="mt-4 space-y-6">
        {groupGap ? (
          <p className="text-xs text-[var(--color-ink-faint)]">
            This employee worked <span className="tnum font-medium">{formatHours(physicalHours)}</span> physical hours (time actually present); the{" "}
            <span className="tnum font-medium">{formatHours(billedHours)}</span> billed hours are higher because on a group session every participant is credited the full session — the money is what divides.
          </p>
        ) : null}

        {monthly.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Pay by month</p>
            <Table head={<><Th>Month</Th><Th numeric>Agency total</Th><Th numeric>Employee amount</Th>{attributionAvailable ? <Th numeric>Paid directly</Th> : null}<Th numeric>Checks</Th></>}>
              {monthly.map((m) => (
                <Tr key={m.month ?? "undated"}>
                  <Td><span className="tnum">{m.month ?? "Undated"}</span></Td>
                  <Td numeric><Money value={m.agencyGross} /></Td>
                  <Td numeric><Money value={m.internalAmount} /></Td>
                  {attributionAvailable ? <Td numeric><Money value={m.paidToEmployee} /></Td> : null}
                  <Td numeric className="tnum">{m.checkCount}</Td>
                </Tr>
              ))}
            </Table>
          </div>
        ) : null}

        {hasPending ? (
          <div>
            <p className="eyebrow mb-2">Scheduled, not yet billed</p>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {schedule.summary.pendingSessions} pending session{schedule.summary.pendingSessions === 1 ? "" : "s"} ·{" "}
              {formatHours(schedule.summary.pendingHours)} h.{" "}
              <Link className="text-[var(--color-primary)] hover:underline" href={`/schedule?employeeId=${id}`}>Open calendar →</Link>
            </p>
          </div>
        ) : null}

        {assignments.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Allowed to serve</p>
            <Table head={<><Th>Person</Th><Th>Program</Th><Th numeric>Allowed hours</Th></>}>
              {assignments.map((a) => (
                <Tr key={a.id}>
                  <Td><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/individuals/${a.individualId}`}>{a.individualName}</Link></Td>
                  <Td><Plain value={a.programName} /></Td>
                  <Td numeric>{a.allowedHours ? <Hours value={a.allowedHours} /> : "—"}</Td>
                </Tr>
              ))}
            </Table>
          </div>
        ) : null}

        {recent.rows.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Recent transactions</p>
            <Table head={<><Th>Check</Th><Th>Person</Th><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Amount</Th></>}>
              {recent.rows.slice(0, 15).map((t) => (
                <Tr key={t.id}>
                  <Td><span className="tnum">{t.checkNumber ?? "—"}</span><p className="text-xs text-[var(--color-ink-faint)]"><Plain value={t.checkDate} /></p></Td>
                  <Td>{t.individualId ? <Link className="text-[var(--color-primary)] hover:underline" href={`/individuals/${t.individualId}`}><Plain value={t.individual} /></Link> : <Plain value={t.individual} />}</Td>
                  <Td><Plain value={t.program} /></Td>
                  <Td numeric><Hours value={t.hours} /></Td>
                  <Td numeric><Money value={t.amount} /></Td>
                </Tr>
              ))}
            </Table>
            <p className="mt-2 text-xs"><Link className="text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id })}>Open the full, filterable ledger →</Link></p>
          </div>
        ) : null}

        {rateExceptions > 0 ? (
          <p className="text-xs text-[var(--color-ink-faint)]">
            {rateExceptions} rate exception{rateExceptions === 1 ? "" : "s"} on this employee&rsquo;s rows — the imported rates were preserved exactly.
          </p>
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

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { resolveAccessScope, canViewEmployee, canViewIndividual, hasDirectEmployeeAccess } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { getEmployeeReport } from "@/lib/data/queries";
import { isUuid, listTransactions } from "@/lib/data/app-queries";
import {
  getEmployeePaymentSummary,
  getEmployeeIndividuals,
  getEmployeeUsageByProgram,
  getEmployeeMonthlyPayments,
  getEmployeeSchedule,
  getEmployeeWithholding,
} from "@/lib/data/employee-queries";
import { txLink } from "@/lib/nav/tx-link";
import { getEmployee } from "@/lib/manage/employees";
import { listAssignments } from "@/lib/manage/assignments";
import { listEmployeeDeals } from "@/lib/manage/employee-deals";
import { getPersonSettlementBalance } from "@/lib/data/settlements";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import {
  Card, Table, Th, Td, Tr, Money, Hours, Plain, ErrorPanel, PageHeader, ButtonLink,
} from "@/components/ui";
import { CreateButton, ActionButton, Field, SelectField, TextAreaField } from "@/components/manage/client";
import TransactionsGrid from "@/components/transactions/transactions-grid";
import EmployeeMerge from "@/components/employees/employee-merge";
import { dec, formatHours, formatMoney } from "@/lib/money";
import { transactionFieldVisibility } from "@/lib/auth/money-redaction";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employee — Ahivim Budget Management" };

/** Shown to a scoped viewer in place of the real schedule (which names individuals). */
const EMPTY_SCHEDULE: Awaited<ReturnType<typeof getEmployeeSchedule>> = {
  summary: { pendingSessions: 0, pendingHours: "0", completedSessions: 0, completedHours: "0", cancelledSessions: 0, noShowSessions: 0 },
  upcoming: [],
};

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
    // A scoped user may only open an employee they have access to; and everything
    // shown about that employee is limited to the individuals they may see.
    const scope = await resolveAccessScope(pool, user);
    if (!canViewEmployee(scope, id)) return null;
    const directAccess = hasDirectEmployeeAccess(scope, id);
    const canSeeEmployeeDeals = scope.canSeeEmployeeDeals && directAccess;
    const canSeeSettlements = scope.canSeeSettlements && directAccess;
    const canSeeCheckNet = scope.canSeeCheckNet && directAccess;
    const canSeeTaxes = scope.canSeeTaxes && directAccess;
    const [report, assignments, recent, payment, individualsServed, usageByProgram, monthly, schedule, withholding, gridRows, deals, settlement] = await Promise.all([
      getEmployeeReport(pool, id, scope),
      listAssignments(pool, { employeeId: id, includeInactive: true }),
      scope.canSeeTransactions
        ? listTransactions(pool, { employeeId: id, limit: 25, scope })
        : Promise.resolve({
            rows: [],
            total: 0,
            totals: { agencyGross: "0.00", internalAmount: "0.00", agencyRetention: "0.00" },
          }),
      getEmployeePaymentSummary(pool, id, scope),
      getEmployeeIndividuals(pool, id, scope),
      getEmployeeUsageByProgram(pool, id, scope),
      getEmployeeMonthlyPayments(pool, id, scope),
      // The schedule (a manager surface, and its upcoming list names individuals)
      // is not shown to viewers.
      canEdit ? getEmployeeSchedule(pool, id) : Promise.resolve(EMPTY_SCHEDULE),
      canSeeTaxes ? getEmployeeWithholding(pool, id, scope) : Promise.resolve({ gross: "0", net: "0", withheld: "0", checks: 0 }),
      // Every transaction for this employee, for the embedded ledger grid.
      scope.canSeeTransactions ? listTransactionsForGrid(pool, scope, { employeeId: id }) : Promise.resolve([]),
      canSeeEmployeeDeals ? listEmployeeDeals(pool, id) : Promise.resolve([]),
      canSeeSettlements ? getPersonSettlementBalance(pool, { employeeId: id }) : Promise.resolve({ payable: "0", receivable: "0", reserve: "0", credit: "0", openItems: 0 }),
    ]);
    const activeAssignments = assignments
      .filter((a) => a.status === "active")
      .filter((a) => canViewIndividual(scope, a.individualId));
    return {
      employee, report, assignments: activeAssignments, recent, payment,
      individualsServed, usageByProgram, monthly, schedule, withholding,
      gridRows, deals, settlement,
      canSeeTransactions: scope.canSeeTransactions,
      canSeeHours: scope.canSeeHours,
      canSeeBilledAmounts: scope.canSeeBilledAmounts,
      canSeeEmployeeAmounts: scope.canSeeEmployeeAmounts,
      canSeeAgencySpread: scope.canSeeAgencySpread,
      canSeeCheckNet,
      canSeeTaxes,
      canSeeBudgets: scope.canSeeBudgets,
      canSeeEmployeeDeals,
      canSeeSettlements,
      transactionVisibility: transactionFieldVisibility(scope),
    };
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

  const {
    employee, report, assignments, recent, payment, individualsServed,
    usageByProgram, monthly, schedule, withholding, gridRows, deals, settlement,
    canSeeTransactions, canSeeHours, canSeeBilledAmounts,
    canSeeEmployeeAmounts, canSeeAgencySpread, canSeeCheckNet, canSeeTaxes,
    canSeeBudgets, canSeeEmployeeDeals, canSeeSettlements, transactionVisibility,
  } = result.data;
  const attributionAvailable = payment.transactionCount === 0 || payment.attributedCount > 0;
  const hasWithholding = dec(withholding.withheld).greaterThan(0);

  const currentDeal = deals.find((deal) => {
    const today = new Date().toISOString().slice(0, 10);
    return deal.status === "active" && deal.effectiveFrom <= today && (!deal.effectiveTo || deal.effectiveTo >= today);
  }) ?? deals.find((deal) => deal.status === "active") ?? null;
  const directPercent = currentDeal ? dec(currentDeal.directPercent).times(100).toDecimalPlaces(2).toString() : "";
  const agencyPercent = currentDeal ? dec(currentDeal.agencyCutPercent).times(100).toDecimalPlaces(2).toString() : "";
  const today = new Date().toISOString().slice(0, 10);

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
      <CreateButton
        label={currentDeal ? "Change deal" : "Set deal"}
        title={currentDeal ? "Change employee deal" : "Set employee deal"}
        endpoint="/api/employee-deals"
        fields={
          <>
            <SelectField
              label="When paid directly"
              name="directRule"
              defaultValue={currentDeal?.directRule ?? "keep_all"}
              options={[
                { value: "keep_all", label: "Employee keeps the whole net check" },
                { value: "giveback_percent", label: "Employee gives the agency a percentage of net" },
                { value: "giveback_all", label: "Employee gives the agency the whole net check" },
              ]}
              required
            />
            <Field label="Direct give-back %" name="directPercent" type="number" defaultValue={directPercent} placeholder="e.g. 10" help="Used only for the percentage option. It is applied to the whole check net, never gross or taxes." />
            <Field label="Agency cut of base %" name="agencyCutPercent" type="number" defaultValue={agencyPercent} placeholder="e.g. 20" help="When the agency receives the funder payment, the employee gets the remaining base amount. The billed spread stays with the agency first." />
            <Field label="Starts on" name="effectiveFrom" type="date" defaultValue={currentDeal?.effectiveFrom ?? today} required />
            <Field label="Ends on (optional)" name="effectiveTo" type="date" defaultValue={currentDeal?.effectiveTo ?? ""} />
            <Field label="Reason for change" name="reason" placeholder="New agreement, correction, annual review…" required />
            <TextAreaField label="Deal notes" name="notes" defaultValue={currentDeal?.notes} />
          </>
        }
        hidden={{ employeeId: id }}
      />
      <EmployeeMerge employeeId={id} employeeName={employee.displayName} />
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
            {canSeeHours ? <>Billed <span className="tnum">{formatHours(report.allocationHours)}</span> hours for </> : <>Served </>}
            <span className="tnum">{report.individualsServed}</span> {report.individualsServed === 1 ? "person" : "people"}
          </p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Across {report.programs.length} program{report.programs.length === 1 ? "" : "s"}
            {report.programs.length ? `: ${report.programs.join(", ")}` : ""}
            {report.groupSessions > 0 ? ` · ${report.groupSessions.toLocaleString()} group sessions` : ""}
          </p>
          {canSeeBilledAmounts || canSeeEmployeeAmounts || canSeeAgencySpread ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {canSeeBilledAmounts ? <MoneyTile label="Agency total (billed)" value={formatMoney(report.agencyGross)} sub="what the funder paid" /> : null}
              {canSeeEmployeeAmounts ? <MoneyTile label="Base amount" value={formatMoney(report.internalAmount)} sub="before the employee deal" /> : null}
              {canSeeAgencySpread ? <MoneyTile label="Agency difference" value={formatMoney(payment.agencyAdditional)} sub="agency total above the employee amount" /> : null}
            </div>
          ) : null}
          {canSeeTaxes && hasWithholding ? (
            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] px-4 py-3">
              <div className="text-sm">
                <span className="font-semibold text-[var(--color-ink)]">Taxes withheld</span>
                <span className="ml-2 text-[var(--color-ink-soft)]">gross minus the net actually received on checks paid to this employee — kept separately</span>
              </div>
              <div className="text-right">
                <span className="tnum text-xl font-semibold">{formatMoney(withholding.withheld)}</span>
                <span className="ml-2 text-xs text-[var(--color-ink-faint)]">
                  {canSeeCheckNet ? `${formatMoney(withholding.gross)} gross − ${formatMoney(withholding.net)} net · ` : ""}
                  {withholding.checks} check{withholding.checks === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="card mb-6 px-5 py-5">
          <p className="text-lg font-semibold">No billed activity yet</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Once this employee has transactions, their hours, people served and pay appear here.</p>
        </section>
      )}

      {canSeeEmployeeDeals || canSeeSettlements ? (
        <section className="mb-6 border-y border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-5 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">{canSeeEmployeeDeals && canSeeSettlements ? "Employee deal and balance" : canSeeEmployeeDeals ? "Employee deal" : "Settlement balance"}</p>
              <h2 className="mt-1 text-lg font-semibold">
                {canSeeEmployeeDeals ? (currentDeal ? `Terms from ${currentDeal.effectiveFrom}` : "No deal is configured") : `${settlement.openItems} open item${settlement.openItems === 1 ? "" : "s"}`}
              </h2>
            </div>
            {canSeeSettlements ? <ButtonLink href={`/settlements?employeeId=${id}`} variant="secondary">Open settlement ledger</ButtonLink> : null}
          </div>
          {canSeeEmployeeDeals && currentDeal ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="border-l-4 border-[var(--color-info)] pl-3">
                <p className="text-sm font-semibold">Employee receives the check directly</p>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  {currentDeal.directRule === "keep_all"
                    ? "The employee keeps the whole check net. Nothing is owed back."
                    : currentDeal.directRule === "giveback_all"
                      ? "The employee gives the agency the whole check net."
                      : `The employee gives the agency ${directPercent}% of the whole check net.`}
                </p>
                <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Gross and taxes remain display facts; neither changes this calculation.</p>
              </div>
              <div className="border-l-4 border-[var(--color-success)] pl-3">
                <p className="text-sm font-semibold">Agency receives the funder payment</p>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">The agency keeps {agencyPercent}% of the base amount and pays the employee the remaining {dec(1).minus(currentDeal.agencyCutPercent).times(100).toDecimalPlaces(2).toString()}%.</p>
                <p className="mt-1 text-xs text-[var(--color-ink-faint)]">The funder-to-base spread is already the agency&rsquo;s and stays outside this deal.</p>
              </div>
            </div>
          ) : canSeeEmployeeDeals ? (
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">Set a start date and terms before the ledger can calculate this employee&rsquo;s checks.</p>
          ) : null}
          {canSeeSettlements ? <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-4">
            <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Agency still pays</p><p className="tnum mt-1 font-semibold">{formatMoney(settlement.payable)}</p></div>
            <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Employee still gives</p><p className="tnum mt-1 font-semibold">{formatMoney(settlement.receivable)}</p></div>
            <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Credit</p><p className="tnum mt-1 font-semibold">{formatMoney(settlement.credit)}</p></div>
            <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Open items</p><p className="tnum mt-1 font-semibold">{settlement.openItems}</p></div>
          </div> : null}
          {canSeeEmployeeDeals && deals.length > 1 ? (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-medium">Deal history ({deals.length})</summary>
              <div className="mt-2 overflow-x-auto">
                <Table head={<><Th>Dates</Th><Th>Direct check</Th><Th>Agency-routed</Th><Th numeric>Revision</Th></>}>
                  {deals.map((deal) => (
                    <Tr key={deal.id}>
                      <Td><span className="tnum">{deal.effectiveFrom}</span>{deal.effectiveTo ? <span className="tnum text-[var(--color-ink-faint)]"> to {deal.effectiveTo}</span> : null}</Td>
                      <Td>{deal.directRule === "keep_all" ? "Keep net" : deal.directRule === "giveback_all" ? "Give all net" : `${dec(deal.directPercent).times(100).toDecimalPlaces(2).toString()}% of net`}</Td>
                      <Td>{dec(deal.agencyCutPercent).times(100).toDecimalPlaces(2).toString()}% of base</Td>
                      <Td numeric className="tnum">{deal.revision}</Td>
                    </Tr>
                  ))}
                </Table>
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {/* ---- Who they served ---- */}
      {individualsServed.length > 0 ? (
        <Card
          title="People served"
          description={canSeeTransactions
            ? "Everyone this employee billed for. Click a name to open their profile, or the rows to see the transactions."
            : "Everyone this employee billed for. Click a name to open their profile."}
          className="mb-6"
        >
          <Table head={<><Th>Person</Th>{canSeeHours ? <Th numeric>Billed hours</Th> : null}<Th numeric>Transactions</Th>{canSeeBilledAmounts ? <Th numeric>Agency total</Th> : null}{canSeeTransactions ? <Th>Open</Th> : null}</>}>
            {individualsServed.map((row) => (
              <Tr key={row.id}>
                <Td><Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${row.id}`}>{row.displayName}</Link></Td>
                {canSeeHours ? <Td numeric><Hours value={row.allocationHours} /></Td> : null}
                <Td numeric className="tnum">{row.transactionCount}</Td>
                {canSeeBilledAmounts ? <Td numeric><Money value={row.agencyGross} /></Td> : null}
                {canSeeTransactions ? <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, individualId: row.id })}>rows →</Link></Td> : null}
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {/* ---- By program ---- */}
      {usageByProgram.length > 0 ? (
        <Card title="Billed by program" description="Activity for each program, straight from the ledger." className="mb-6"
          action={canSeeTransactions ? <ButtonLink href={txLink({ employeeId: id })} variant="secondary">All rows →</ButtonLink> : undefined}>
          <Table head={<><Th>Program</Th>{canSeeHours ? <Th numeric>Billed hours</Th> : null}<Th numeric>Transactions</Th>{canSeeBilledAmounts ? <Th numeric>Agency total</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Employee amount</Th> : null}{canSeeTransactions ? <Th>Open</Th> : null}</>}>
            {usageByProgram.map((row) => (
              <Tr key={row.programCode}>
                <Td>{canSeeTransactions
                  ? <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={txLink({ employeeId: id, program: row.programName })}>{row.programName}</Link>
                  : <span className="font-medium">{row.programName}</span>}</Td>
                {canSeeHours ? <Td numeric><Hours value={row.allocationHours} /></Td> : null}
                <Td numeric className="tnum">{row.transactionCount}</Td>
                {canSeeBilledAmounts ? <Td numeric><Money value={row.agencyGross} /></Td> : null}
                {canSeeEmployeeAmounts ? <Td numeric><Money value={row.internalAmount} /></Td> : null}
                {canSeeTransactions ? <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, program: row.programName })}>rows →</Link></Td> : null}
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {/* ---- All transactions — the full ledger grid, scoped to this employee ---- */}
      {canSeeTransactions && gridRows.length > 0 ? (
        <section className="mb-6">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">All transactions</h2>
            <span className="text-xs text-[var(--color-text-soft)]">{gridRows.length.toLocaleString()} rows · filter, sort, total{canEdit ? " and mark paid" : ""}, like the Transactions page</span>
          </div>
          <TransactionsGrid rows={gridRows} canManage={canEdit} visibility={transactionVisibility} canSeeBudgets={canSeeBudgets} contextLabel={null} />
        </section>
      ) : null}

      {/* ---- Everything else, folded away ---- */}
      <MoreDetails
        id={id}
        recent={recent}
        assignments={assignments}
        schedule={schedule}
        monthly={monthly}
        canSeeHours={canSeeHours}
        canSeeBilledAmounts={canSeeBilledAmounts}
        canSeeEmployeeAmounts={canSeeEmployeeAmounts}
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
  id, recent, assignments, schedule, monthly, canSeeHours, canSeeBilledAmounts,
  canSeeEmployeeAmounts, attributionAvailable, rateExceptions, physicalHours, billedHours, notes,
}: {
  id: string;
  recent: Awaited<ReturnType<typeof listTransactions>>;
  assignments: Awaited<ReturnType<typeof listAssignments>>;
  schedule: Awaited<ReturnType<typeof getEmployeeSchedule>>;
  monthly: Awaited<ReturnType<typeof getEmployeeMonthlyPayments>>;
  canSeeHours: boolean;
  canSeeBilledAmounts: boolean;
  canSeeEmployeeAmounts: boolean;
  attributionAvailable: boolean;
  rateExceptions: number;
  physicalHours: string;
  billedHours: string;
  notes: string | null;
}) {
  const hasPending = schedule.summary.pendingSessions > 0;
  const groupGap = canSeeHours && dec(billedHours).greaterThan(dec(physicalHours));
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
            <Table head={<><Th>Month</Th>{canSeeBilledAmounts ? <Th numeric>Agency total</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Employee amount</Th> : null}{canSeeEmployeeAmounts && attributionAvailable ? <Th numeric>Paid directly</Th> : null}<Th numeric>Checks</Th></>}>
              {monthly.map((m) => (
                <Tr key={m.month ?? "undated"}>
                  <Td><span className="tnum">{m.month ?? "Undated"}</span></Td>
                  {canSeeBilledAmounts ? <Td numeric><Money value={m.agencyGross} /></Td> : null}
                  {canSeeEmployeeAmounts ? <Td numeric><Money value={m.internalAmount} /></Td> : null}
                  {canSeeEmployeeAmounts && attributionAvailable ? <Td numeric><Money value={m.paidToEmployee} /></Td> : null}
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
            <Table head={<><Th>Person</Th><Th>Program</Th>{canSeeHours ? <Th numeric>Allowed hours</Th> : null}</>}>
              {assignments.map((a) => (
                <Tr key={a.id}>
                  <Td><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/individuals/${a.individualId}`}>{a.individualName}</Link></Td>
                  <Td><Plain value={a.programName} /></Td>
                  {canSeeHours ? <Td numeric>{a.allowedHours ? <Hours value={a.allowedHours} /> : "—"}</Td> : null}
                </Tr>
              ))}
            </Table>
          </div>
        ) : null}

        {recent.rows.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Recent transactions</p>
            <Table head={<><Th>Check</Th><Th>Person</Th><Th>Program</Th>{canSeeHours ? <Th numeric>Hours</Th> : null}{canSeeBilledAmounts ? <Th numeric>Amount</Th> : null}</>}>
              {recent.rows.slice(0, 15).map((t) => (
                <Tr key={t.id}>
                  <Td><span className="tnum">{t.checkNumber ?? "—"}</span><p className="text-xs text-[var(--color-ink-faint)]"><Plain value={t.checkDate} /></p></Td>
                  <Td>{t.individualId ? <Link className="text-[var(--color-primary)] hover:underline" href={`/individuals/${t.individualId}`}><Plain value={t.individual} /></Link> : <Plain value={t.individual} />}</Td>
                  <Td><Plain value={t.program} /></Td>
                  {canSeeHours ? <Td numeric><Hours value={t.hours} /></Td> : null}
                  {canSeeBilledAmounts ? <Td numeric><Money value={t.amount} /></Td> : null}
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

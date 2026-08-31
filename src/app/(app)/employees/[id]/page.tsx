import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import {
  canViewEmployee,
  canViewIndividual,
  hasDirectEmployeeAccess,
  isPlanningOnlyAccess,
  resolveAccessScope,
} from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { getEmployeeReport } from "@/lib/data/queries";
import { isUuid, listTransactions } from "@/lib/data/app-queries";
import {
  getEmployeePaymentSummary,
  getEmployeeIndividuals,
  getEmployeeUsageByProgram,
  getEmployeeMonthlyPayments,
  getEmployeePlanningSummary,
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
import { TabPanels } from "@/components/ui-client";
import { CreateButton, ActionButton, Field, SelectField, TextAreaField } from "@/components/manage/client";
import TransactionsGrid from "@/components/transactions/transactions-grid";
import EmployeeMerge from "@/components/employees/employee-merge";
import { dec, formatHours, formatMoney } from "@/lib/money";
import { transactionFieldVisibility } from "@/lib/auth/money-redaction";
import { planningEmployeeProfile } from "@/lib/auth/employee-planning-access";
import { agencyDate } from "@/lib/business/agency-time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employee — Ahivim Budget Management" };

/** Shown to a scoped viewer in place of the real schedule (which names individuals). */
const EMPTY_SCHEDULE: Awaited<ReturnType<typeof getEmployeeSchedule>> = {
  summary: { pendingSessions: 0, pendingHours: "0", completedSessions: 0, completedHours: "0", cancelledSessions: 0, noShowSessions: 0 },
  upcoming: [],
};

const EMPTY_PAYMENT: Awaited<ReturnType<typeof getEmployeePaymentSummary>> = {
  agencyGross: "0.00",
  internalAmount: "0.00",
  agencyAdditional: "0.00",
  totalPayment: "0.00",
  paidToEmployee: "0.00",
  payableByAgency: "0.00",
  unknownRecipient: "0.00",
  transactionCount: 0,
  attributedCount: 0,
  checkCount: 0,
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
export default async function EmployeeDetailPage({
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
    const [employee, scope] = await Promise.all([
      getEmployee(pool, id),
      resolveAccessScope(pool, user),
    ]);
    if (!employee) return null;
    // A scoped user may only open an employee they have access to; and everything
    // shown about that employee is limited to the individuals they may see.
    if (!canViewEmployee(scope, id)) return null;
    const planningOnly = isPlanningOnlyAccess(scope);
    const directAccess = hasDirectEmployeeAccess(scope, id);
    const canSeeEmployeeDeals = scope.canSeeEmployeeDeals && directAccess;
    const canSeeSettlements = scope.canSeeSettlements && directAccess;
    const canSeeCheckNet = scope.canSeeCheckNet && directAccess;
    const canSeeTaxes = scope.canSeeTaxes && directAccess;
    const [report, assignments, recent, payment, individualsServed, usageByProgram, monthly, schedule, withholding, gridRows, deals, settlement, planningSummary] = await Promise.all([
      planningOnly ? Promise.resolve(null) : getEmployeeReport(pool, id, scope),
      listAssignments(pool, { employeeId: id, includeInactive: true }),
      scope.canSeeTransactions
        ? listTransactions(pool, { employeeId: id, limit: 25, scope })
        : Promise.resolve({
            rows: [],
            total: 0,
            totals: { agencyGross: "0.00", internalAmount: "0.00", agencyRetention: "0.00" },
          }),
      planningOnly ? Promise.resolve(EMPTY_PAYMENT) : getEmployeePaymentSummary(pool, id, scope),
      planningOnly ? Promise.resolve([]) : getEmployeeIndividuals(pool, id, scope),
      planningOnly ? Promise.resolve([]) : getEmployeeUsageByProgram(pool, id, scope),
      planningOnly ? Promise.resolve([]) : getEmployeeMonthlyPayments(pool, id, scope),
      // The schedule (a manager surface, and its upcoming list names individuals)
      // is not shown to viewers.
      canEdit ? getEmployeeSchedule(pool, id) : Promise.resolve(EMPTY_SCHEDULE),
      canSeeTaxes ? getEmployeeWithholding(pool, id, scope) : Promise.resolve({ gross: "0", net: "0", withheld: "0", grossKnownChecks: 0, checks: 0 }),
      // Every transaction for this employee, for the embedded ledger grid.
      scope.canSeeTransactions ? listTransactionsForGrid(pool, scope, { employeeId: id }) : Promise.resolve([]),
      canSeeEmployeeDeals ? listEmployeeDeals(pool, id) : Promise.resolve([]),
      canSeeSettlements ? getPersonSettlementBalance(pool, { employeeId: id }) : Promise.resolve({ payable: "0", receivable: "0", reserve: "0", credit: "0", openItems: 0 }),
      planningOnly ? getEmployeePlanningSummary(pool, id) : Promise.resolve(null),
    ]);
    const activeAssignments = assignments
      .filter((a) => a.status === "active")
      .filter((a) => canViewIndividual(scope, a.individualId));
    return {
      employee: planningOnly ? planningEmployeeProfile(employee) : employee,
      report, assignments: activeAssignments, recent, payment,
      individualsServed, usageByProgram, monthly, schedule, withholding,
      gridRows, deals, settlement, planningSummary, planningOnly,
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
    planningSummary, planningOnly,
    canSeeTransactions, canSeeHours, canSeeBilledAmounts,
    canSeeEmployeeAmounts, canSeeAgencySpread, canSeeCheckNet, canSeeTaxes,
    canSeeBudgets, canSeeEmployeeDeals, canSeeSettlements, transactionVisibility,
  } = result.data;
  const employeeNotes = "notes" in employee && typeof employee.notes === "string"
    ? employee.notes
    : null;
  const attributionAvailable = payment.transactionCount === 0 || payment.attributedCount > 0;
  const hasWithholding = dec(withholding.withheld).greaterThan(0);

  const today = agencyDate();
  const currentDeal = deals.find((deal) => {
    return deal.status === "active" && deal.effectiveFrom <= today && (!deal.effectiveTo || deal.effectiveTo >= today);
  }) ?? deals.find((deal) => deal.status === "active") ?? null;
  const directPercent = currentDeal ? dec(currentDeal.directPercent).times(100).toDecimalPlaces(2).toString() : "";
  const agencyPercent = currentDeal ? dec(currentDeal.agencyCutPercent).times(100).toDecimalPlaces(2).toString() : "";
  const headerActions = planningOnly ? (
    <ButtonLink href={`/schedule?view=schedules&employeeId=${id}`}>Open service schedules</ButtonLink>
  ) : canEdit ? (
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
            <TextAreaField label="Notes" name="notes" defaultValue={employeeNotes} />
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
            <Field label="Default agency cut of base %" name="agencyCutPercent" type="number" defaultValue={agencyPercent} placeholder="e.g. 20" help="Used when this employee has no person-specific pay rule. The billed spread always stays with the agency." />
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
  const hasPending = schedule.summary.pendingSessions > 0;
  const groupGap = canSeeHours && report ? dec(report.allocationHours).greaterThan(dec(report.physicalHours)) : false;
  const hasCheckActivity = monthly.length > 0 || hasPending || recent.rows.length > 0 || (canSeeTransactions && gridRows.length > 0);

  return (
    <>
      <PageHeader eyebrow={planningOnly ? "Planning" : "Employee"} title={employee.displayName} action={headerActions} />
      <TabPanels
        initialId={initialView}
        paramKey="view"
        panels={[
          {
            id: "overview",
            label: "Overview",
            content: planningOnly && planningSummary ? (
              <section className="card fade-in-up px-5 py-5">
                <p className="eyebrow">Service hours</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <MoneyTile label="Recorded service" value={`${formatHours(planningSummary.recordedServiceHours)} h`} plain />
                  <MoneyTile
                    label="Scheduled next"
                    value={`${formatHours(planningSummary.pendingHours)} h`}
                    sub={`${planningSummary.pendingSessions} pending session${planningSummary.pendingSessions === 1 ? "" : "s"}`}
                    plain
                  />
                  <MoneyTile label="Active assignments" value={assignments.length.toLocaleString()} plain />
                </div>
                <p className="mt-4 text-sm text-[var(--color-ink-soft)]">
                  {planningSummary.groupSessions > 0
                    ? `${planningSummary.groupSessions.toLocaleString()} recorded group session${planningSummary.groupSessions === 1 ? "" : "s"}. `
                    : ""}
                  Use Planning to review the employee&rsquo;s recurring schedule and authorization coverage.
                </p>
              </section>
            ) : hasActivity && report ? (
              <section className="card fade-in-up px-5 py-5">
                <p className="eyebrow">Service activity</p>
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
                    {canSeeBilledAmounts ? <MoneyTile label="Funder billed" value={formatMoney(report.agencyGross)} /> : null}
                    {canSeeEmployeeAmounts ? <MoneyTile label="Employee base" value={formatMoney(report.internalAmount)} /> : null}
                    {canSeeAgencySpread ? <MoneyTile label="Agency spread" value={formatMoney(payment.agencyAdditional)} /> : null}
                  </div>
                ) : null}
                {canSeeTaxes && hasWithholding ? (
                  <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] px-4 py-3">
                    <div className="text-sm">
                      <span className="font-semibold text-[var(--color-ink)]">Taxes withheld</span>
                      <span className="ml-2 text-[var(--color-ink-soft)]">recorded from the payroll check; not used in give-back calculations</span>
                    </div>
                    <div className="text-right">
                      <span className="tnum text-xl font-semibold">{formatMoney(withholding.withheld)}</span>
                      <span className="ml-2 text-xs text-[var(--color-ink-faint)]">
                        {canSeeCheckNet && withholding.grossKnownChecks === withholding.checks
                          ? `${formatMoney(withholding.gross)} gross · ${formatMoney(withholding.net)} net · `
                          : withholding.grossKnownChecks > 0
                            ? `${withholding.grossKnownChecks} with gross · `
                            : ""}
                        {withholding.checks} check{withholding.checks === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : (
              <section className="card px-5 py-5">
                <p className="text-lg font-semibold">No billed activity</p>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">No transactions are recorded for this employee.</p>
              </section>
            ),
          },
          ...(planningOnly ? [] : [{
            id: "checks",
            label: "Checks/Activity",
            content: (
              <div className="space-y-6">
                {monthly.length > 0 ? (
                  <Card title="Checks by month">
                    <Table head={<><Th>Month</Th>{canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Employee base</Th> : null}{canSeeEmployeeAmounts && attributionAvailable ? <Th numeric>Paid directly</Th> : null}<Th numeric>Checks</Th></>}>
                      {monthly.map((month) => (
                        <Tr key={month.month ?? "undated"}>
                          <Td><span className="tnum">{month.month ?? "Undated"}</span></Td>
                          {canSeeBilledAmounts ? <Td numeric><Money value={month.agencyGross} /></Td> : null}
                          {canSeeEmployeeAmounts ? <Td numeric><Money value={month.internalAmount} /></Td> : null}
                          {canSeeEmployeeAmounts && attributionAvailable ? <Td numeric><Money value={month.paidToEmployee} /></Td> : null}
                          <Td numeric className="tnum">{month.checkCount}</Td>
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {hasPending ? (
                  <section className="card px-5 py-4">
                    <p className="eyebrow">Scheduled, not yet billed</p>
                    <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                      {schedule.summary.pendingSessions} pending session{schedule.summary.pendingSessions === 1 ? "" : "s"} · {formatHours(schedule.summary.pendingHours)} h
                    </p>
                    <p className="mt-2 text-sm"><Link className="text-[var(--color-primary)] hover:underline" href={`/schedule?employeeId=${id}`}>Open calendar →</Link></p>
                  </section>
                ) : null}
                {recent.rows.length > 0 ? (
                  <Card
                    title="Recent transactions"
                    action={canSeeTransactions ? <ButtonLink href={txLink({ employeeId: id })} variant="secondary">Open ledger →</ButtonLink> : undefined}
                  >
                    <Table head={<><Th>Check</Th><Th>Person</Th><Th>Program</Th>{canSeeHours ? <Th numeric>Hours</Th> : null}{canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}</>}>
                      {recent.rows.slice(0, 15).map((transaction) => (
                        <Tr key={transaction.id}>
                          <Td><span className="tnum">{transaction.checkNumber ?? "—"}</span><p className="text-xs text-[var(--color-ink-faint)]"><Plain value={transaction.checkDate} /></p></Td>
                          <Td>{transaction.individualId ? <Link className="text-[var(--color-primary)] hover:underline" href={`/individuals/${transaction.individualId}`}><Plain value={transaction.individual} /></Link> : <Plain value={transaction.individual} />}</Td>
                          <Td><Plain value={transaction.program} /></Td>
                          {canSeeHours ? <Td numeric><Hours value={transaction.hours} /></Td> : null}
                          {canSeeBilledAmounts ? <Td numeric><Money value={transaction.amount} /></Td> : null}
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {canSeeTransactions && gridRows.length > 0 ? (
                  <section className="border-t border-[var(--color-rule)] pt-6">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <h2 className="text-lg font-semibold">Transaction ledger</h2>
                      <span className="text-xs text-[var(--color-text-soft)]">{gridRows.length.toLocaleString()} source rows</span>
                    </div>
                    <TransactionsGrid rows={gridRows} canManage={canEdit} visibility={transactionVisibility} canSeeBudgets={canSeeBudgets} contextLabel={null} />
                  </section>
                ) : null}
                {!hasCheckActivity ? <section className="card px-5 py-5 text-sm text-[var(--color-ink-soft)]">No check or service activity is recorded.</section> : null}
              </div>
            ),
          }]),
          ...(canSeeEmployeeDeals || canSeeSettlements ? [{
            id: "deal",
            label: "Deal & Payments",
            content: (
              <section className="border-y border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-5 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="eyebrow">{canSeeEmployeeDeals && canSeeSettlements ? "Employee deal and payments" : canSeeEmployeeDeals ? "Employee deal" : "Payment balance"}</p>
                    <h2 className="mt-1 text-lg font-semibold">
                      {canSeeEmployeeDeals ? (currentDeal ? `Terms from ${currentDeal.effectiveFrom}` : "No deal is configured") : `${settlement.openItems} open item${settlement.openItems === 1 ? "" : "s"}`}
                    </h2>
                  </div>
                  {canSeeSettlements ? <ButtonLink href={`/settlements?employeeId=${id}`} variant="secondary">Open payments</ButtonLink> : null}
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
                      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Gross and taxes do not change this net-based calculation.</p>
                    </div>
                    <div className="border-l-4 border-[var(--color-success)] pl-3">
                      <p className="text-sm font-semibold">Agency receives the funder payment</p>
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">By default, the agency keeps {agencyPercent}% of the employee base and pays the remaining {dec(1).minus(currentDeal.agencyCutPercent).times(100).toDecimalPlaces(2).toString()}%.</p>
                      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">A person-specific pay rule takes priority. Agency spread remains outside every deal.</p>
                    </div>
                  </div>
                ) : canSeeEmployeeDeals ? (
                  <p className="mt-2 text-sm text-[var(--color-ink-soft)]">No active deal terms are configured.</p>
                ) : null}
                {canSeeSettlements ? (
                  <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-4">
                    <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Agency still pays</p><p className="tnum mt-1 font-semibold">{formatMoney(settlement.payable)}</p></div>
                    <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Employee still gives</p><p className="tnum mt-1 font-semibold">{formatMoney(settlement.receivable)}</p></div>
                    <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Credit</p><p className="tnum mt-1 font-semibold">{formatMoney(settlement.credit)}</p></div>
                    <div className="bg-[var(--color-surface-muted)] px-3 py-2"><p className="text-xs text-[var(--color-ink-faint)]">Open items</p><p className="tnum mt-1 font-semibold">{settlement.openItems}</p></div>
                  </div>
                ) : null}
                {canSeeEmployeeDeals && deals.length > 1 ? (
                  <div className="mt-5 overflow-x-auto">
                    <h3 className="mb-2 text-sm font-semibold">Deal history ({deals.length})</h3>
                    <Table head={<><Th>Dates</Th><Th>Direct check</Th><Th>Agency-routed</Th><Th numeric>Revision</Th></>}>
                      {deals.map((deal) => (
                        <Tr key={deal.id}>
                          <Td><span className="tnum">{deal.effectiveFrom}</span>{deal.effectiveTo ? <span className="tnum text-[var(--color-ink-faint)]"> to {deal.effectiveTo}</span> : null}</Td>
                          <Td>{deal.directRule === "keep_all" ? "Keep net" : deal.directRule === "giveback_all" ? "Give all net" : `${dec(deal.directPercent).times(100).toDecimalPlaces(2).toString()}% of net`}</Td>
                          <Td>{dec(deal.agencyCutPercent).times(100).toDecimalPlaces(2).toString()}% of employee base (default)</Td>
                          <Td numeric className="tnum">{deal.revision}</Td>
                        </Tr>
                      ))}
                    </Table>
                  </div>
                ) : null}
              </section>
            ),
          }] : []),
          {
            id: "people",
            label: "People & Programs",
            content: (
              <div className="space-y-6">
                {individualsServed.length > 0 ? (
                  <Card title="People served" description="Individuals included in this employee&apos;s transaction history.">
                    <Table head={<><Th>Person</Th>{canSeeHours ? <Th numeric>Billed hours</Th> : null}<Th numeric>Transactions</Th>{canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}{canSeeTransactions ? <Th>Open</Th> : null}</>}>
                      {individualsServed.map((row) => (
                        <Tr key={row.id}>
                          <Td><Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${row.id}`}>{row.displayName}</Link></Td>
                          {canSeeHours ? <Td numeric><Hours value={row.allocationHours} /></Td> : null}
                          <Td numeric className="tnum">{row.transactionCount}</Td>
                          {canSeeBilledAmounts ? <Td numeric><Money value={row.agencyGross} /></Td> : null}
                          {canSeeTransactions ? <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, individualId: row.id })}>Rows →</Link></Td> : null}
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {usageByProgram.length > 0 ? (
                  <Card title="Billed by program" description="Transaction activity grouped by program."
                    action={canSeeTransactions ? <ButtonLink href={txLink({ employeeId: id })} variant="secondary">All rows →</ButtonLink> : undefined}>
                    <Table head={<><Th>Program</Th>{canSeeHours ? <Th numeric>Billed hours</Th> : null}<Th numeric>Transactions</Th>{canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Employee base</Th> : null}{canSeeTransactions ? <Th>Open</Th> : null}</>}>
                      {usageByProgram.map((row) => (
                        <Tr key={row.programCode}>
                          <Td>{canSeeTransactions
                            ? <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={txLink({ employeeId: id, program: row.programName })}>{row.programName}</Link>
                            : <span className="font-medium">{row.programName}</span>}</Td>
                          {canSeeHours ? <Td numeric><Hours value={row.allocationHours} /></Td> : null}
                          <Td numeric className="tnum">{row.transactionCount}</Td>
                          {canSeeBilledAmounts ? <Td numeric><Money value={row.agencyGross} /></Td> : null}
                          {canSeeEmployeeAmounts ? <Td numeric><Money value={row.internalAmount} /></Td> : null}
                          {canSeeTransactions ? <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, program: row.programName })}>Rows →</Link></Td> : null}
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {assignments.length > 0 ? (
                  <Card title="Allowed assignments">
                    <Table head={<><Th>Person</Th><Th>Program</Th>{canSeeHours ? <Th numeric>Allowed hours</Th> : null}</>}>
                      {assignments.map((assignment) => (
                        <Tr key={assignment.id}>
                          <Td><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/individuals/${assignment.individualId}`}>{assignment.individualName}</Link></Td>
                          <Td><Plain value={assignment.programName} /></Td>
                          {canSeeHours ? <Td numeric>{assignment.allowedHours ? <Hours value={assignment.allowedHours} /> : "—"}</Td> : null}
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {individualsServed.length === 0 && usageByProgram.length === 0 && assignments.length === 0 ? (
                  <section className="card px-5 py-5 text-sm text-[var(--color-ink-soft)]">No people or programs are associated with this employee.</section>
                ) : null}
              </div>
            ),
          },
          {
            id: "details",
            label: "Details",
            content: (
              <section className="card px-5 py-5">
                <h2 className="text-base font-semibold text-[var(--color-ink)]">Profile details</h2>
                <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div><dt className="eyebrow">Status</dt><dd className="mt-1 text-sm font-medium capitalize">{employee.status}</dd></div>
                  {report ? <div><dt className="eyebrow">Rate exceptions</dt><dd className="tnum mt-1 text-sm font-medium">{report.rateExceptions}</dd></div> : null}
                </dl>
                {groupGap && report ? (
                  <p className="mt-5 border-t border-[var(--color-rule)] pt-4 text-sm text-[var(--color-ink-soft)]">
                    Physical hours: <span className="tnum font-medium text-[var(--color-ink)]">{formatHours(report.physicalHours)}</span>. Billed hours: <span className="tnum font-medium text-[var(--color-ink)]">{formatHours(report.allocationHours)}</span>. Group sessions credit each participant with the full session while dividing the money.
                  </p>
                ) : null}
                {!planningOnly && employeeNotes ? (
                  <div className="mt-5 border-t border-[var(--color-rule)] pt-4">
                    <p className="eyebrow mb-2">Notes</p>
                    <p className="whitespace-pre-wrap text-sm">{employeeNotes}</p>
                  </div>
                ) : null}
              </section>
            ),
          },
        ]}
      />
    </>
  );
}

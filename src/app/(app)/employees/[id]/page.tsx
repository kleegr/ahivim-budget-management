import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import {
  canAccessPlanning,
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
import {
  getEmployeeMoneyProfile,
  listEmployeeProfileChecks,
  listEmployeeProfilePreviewAccounts,
  normalizeEmployeeProfileView,
  type EmployeeMoneyFlowSummary,
} from "@/lib/data/employee-profile";
import { collectionsPayrollCheckFocusHref } from "@/lib/nav/collections-links";
import EmployeeAvailabilityManager from "@/components/schedule/employee-availability-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employee — Ahivim Budget Management" };

/** Shown when the viewer is not authorized for Planning's named schedule. */
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

const EMPTY_MONEY: Awaited<ReturnType<typeof getEmployeeMoneyProfile>> = {
  directPay: { due: "0.00", paid: "0.00", credit: "0.00", remaining: "0.00", openItems: 0 },
  agencyRouted: { due: "0.00", paid: "0.00", credit: "0.00", remaining: "0.00", openItems: 0 },
  roots: [],
  events: [],
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

function FlowSummary({
  flow,
  summary,
}: {
  flow: "Direct-Pay" | "Agency-Routed";
  summary: EmployeeMoneyFlowSummary;
}) {
  const direct = flow === "Direct-Pay";
  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-4 py-4">
      <p className="eyebrow">{flow}</p>
      <h3 className="mt-1 text-base font-semibold">
        {direct ? "Employee receives the funder check" : "Agency receives the funder payment"}
      </h3>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        {direct
          ? "Any give-back is calculated from the actual payroll-check net. This is money the Employee may owe the Agency."
          : "The Employee base is routed through the Agency. This is money the Agency may owe the Employee; billed spread is not employee pay."}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-[var(--color-ink-faint)]">Calculated</dt><dd className="tnum mt-1 font-semibold">{formatMoney(summary.due)}</dd></div>
        <div><dt className="text-[var(--color-ink-faint)]">Recorded payments</dt><dd className="tnum mt-1 font-semibold">{formatMoney(summary.paid)}</dd></div>
        <div><dt className="text-[var(--color-ink-faint)]">Still open</dt><dd className="tnum mt-1 font-semibold">{formatMoney(summary.remaining)}</dd></div>
        <div><dt className="text-[var(--color-ink-faint)]">Credit / reversal</dt><dd className="tnum mt-1 font-semibold">{formatMoney(summary.credit)}</dd></div>
      </dl>
    </section>
  );
}

const PROFILE_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function profileDate(value: string | null): string {
  return value ? PROFILE_DATE.format(new Date(`${value}T00:00:00Z`)) : "Not set";
}

function scheduleHref(employeeId: string, sessionId: string, sessionDate: string): string {
  const query = new URLSearchParams({
    view: "calendar",
    calendarView: "day",
    date: sessionDate,
    employeeId,
    sessionId,
  });
  return `/schedule?${query.toString()}`;
}
export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ view?: string | string[]; effectiveFrom?: string | string[] }>;
}) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const [{ id }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<{ view?: string | string[]; effectiveFrom?: string | string[] }>({}),
  ]);
  const initialView = normalizeEmployeeProfileView(typeof query.view === "string" ? query.view : undefined);
  const requestedEffectiveFrom = typeof query.effectiveFrom === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(query.effectiveFrom)
    ? query.effectiveFrom
    : null;
  if (!isUuid(id)) notFound();
  const today = agencyDate();

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
    const canPlanProfile = canAccessPlanning(scope);
    const directAccess = hasDirectEmployeeAccess(scope, id);
    const canSeeEmployeeDeals = scope.canSeeEmployeeDeals && directAccess;
    const canSeeSettlements = scope.canSeeSettlements && directAccess;
    const canSeeCheckNet = scope.canSeeCheckNet && directAccess;
    const canSeeTaxes = scope.canSeeTaxes && directAccess;
    const [
      report,
      assignments,
      recent,
      payment,
      individualsServed,
      usageByProgram,
      monthly,
      schedule,
      withholding,
      gridRows,
      deals,
      money,
      planningSummary,
      checks,
      previewAccounts,
    ] = await Promise.all([
      planningOnly ? Promise.resolve(null) : getEmployeeReport(pool, id, scope),
      listAssignments(pool, { employeeId: id, includeInactive: true, scope }),
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
      canPlanProfile ? getEmployeeSchedule(pool, id) : Promise.resolve(EMPTY_SCHEDULE),
      canSeeCheckNet || canSeeTaxes
        ? getEmployeeWithholding(pool, id, scope)
        : Promise.resolve({ gross: "0", net: "0", withheld: "0", grossKnownChecks: 0, checks: 0 }),
      // Every transaction for this employee, for the embedded ledger grid.
      scope.canSeeTransactions ? listTransactionsForGrid(pool, scope, { employeeId: id }) : Promise.resolve([]),
      canSeeEmployeeDeals ? listEmployeeDeals(pool, id) : Promise.resolve([]),
      canSeeSettlements ? getEmployeeMoneyProfile(pool, id) : Promise.resolve(EMPTY_MONEY),
      planningOnly ? getEmployeePlanningSummary(pool, id) : Promise.resolve(null),
      canSeeCheckNet || canSeeTaxes
        ? listEmployeeProfileChecks(pool, id, {
            gross: canSeeCheckNet,
            net: canSeeCheckNet,
            tax: canSeeTaxes,
            transactions: scope.canSeeTransactions,
          })
        : Promise.resolve([]),
      user.role === "admin" ? listEmployeeProfilePreviewAccounts(pool, id) : Promise.resolve([]),
    ]);
    const activeAssignments = assignments
      .filter((a) => a.status === "active")
      .filter((a) => (!a.startDate || a.startDate <= today) && (!a.endDate || a.endDate >= today))
      .filter((a) => canViewIndividual(scope, a.individualId));
    return {
      employee: planningOnly ? planningEmployeeProfile(employee) : employee,
      report, assignments: activeAssignments, recent, payment,
      individualsServed, usageByProgram, monthly, schedule, withholding,
      gridRows, deals, money, planningSummary, checks, previewAccounts, planningOnly, canPlanProfile,
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
    usageByProgram, monthly, schedule, withholding, gridRows, deals, money,
    planningSummary, checks, previewAccounts, planningOnly, canPlanProfile,
    canSeeTransactions, canSeeHours, canSeeBilledAmounts,
    canSeeEmployeeAmounts, canSeeAgencySpread, canSeeCheckNet, canSeeTaxes,
    canSeeBudgets, canSeeEmployeeDeals, canSeeSettlements, transactionVisibility,
  } = result.data;
  const employeeNotes = "notes" in employee && typeof employee.notes === "string"
    ? employee.notes
    : null;
  const attributionAvailable = payment.transactionCount === 0 || payment.attributedCount > 0;

  const currentDeal = deals.find((deal) => {
    return deal.status === "active" && deal.effectiveFrom <= today && (!deal.effectiveTo || deal.effectiveTo >= today);
  }) ?? deals.find((deal) => deal.status === "active") ?? null;
  const directPercent = currentDeal ? dec(currentDeal.directPercent).times(100).toDecimalPlaces(2).toString() : "";
  const agencyPercent = currentDeal ? dec(currentDeal.agencyCutPercent).times(100).toDecimalPlaces(2).toString() : "";
  const portalPreviewAction = user.role === "admin" ? (
    previewAccounts.length > 0 ? (
      <form
        action="/api/auth/impersonation/start"
        method="post"
        className="flex flex-wrap items-center gap-2"
        title="Open the actual server-authorized Employee portal"
      >
        {previewAccounts.length === 1 ? (
          <input type="hidden" name="targetUserId" value={previewAccounts[0]!.userId} />
        ) : (
          <>
            <label className="sr-only" htmlFor="employee-portal-preview-account">Employee portal account</label>
            <select id="employee-portal-preview-account" name="targetUserId" className="input h-9 min-w-44 text-sm">
              {previewAccounts.map((account) => (
                <option key={account.userId} value={account.userId}>
                  {account.displayName} · {account.email}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="submit" className="btn btn-sm btn-primary">Preview Employee portal</button>
      </form>
    ) : (
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        disabled
        title="Link an active Employee self-service account first"
      >
        Preview Employee portal
      </button>
    )
  ) : null;
  const headerActions = planningOnly ? (
    <ButtonLink href={`/schedule?view=schedules&employeeId=${id}`}>Open service schedules</ButtonLink>
  ) : canEdit ? (
    <div className="flex flex-wrap items-center gap-2">
      {portalPreviewAction}
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
            <Field label="Starts on" name="effectiveFrom" type="date" defaultValue={requestedEffectiveFrom ?? currentDeal?.effectiveFrom ?? today} required />
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

  const groupGap = canSeeHours && report ? dec(report.allocationHours).greaterThan(dec(report.physicalHours)) : false;
  const hasActualActivity = Boolean(
    (planningSummary && dec(planningSummary.recordedServiceHours).greaterThan(0))
    || report?.individualsServed
    || recent.rows.length
    || gridRows.length,
  );
  const hasMoneyAccess = canSeeEmployeeAmounts
    || canSeeCheckNet
    || canSeeTaxes
    || canSeeEmployeeDeals
    || canSeeSettlements;

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
            content: (
              <div className="space-y-6">
                <section className="card fade-in-up px-5 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="eyebrow">Employee 360</p>
                      <h2 className="mt-1 text-xl font-semibold">Actual work, future staffing, and money in one profile</h2>
                    </div>
                    <span className="badge capitalize">{employee.status}</span>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <MoneyTile
                      label="Actual service"
                      value={`${formatHours(planningOnly ? planningSummary?.recordedServiceHours ?? "0" : report?.physicalHours ?? "0")} h`}
                      sub="Physical time recorded; group sessions counted once"
                      plain
                    />
                    <MoneyTile
                      label="People actually served"
                      value={(report?.individualsServed ?? 0).toLocaleString()}
                      sub={planningOnly ? "Hidden on the finance-free planning profile" : "Transaction-backed individuals"}
                      plain
                    />
                    <MoneyTile
                      label="Current assignments"
                      value={assignments.length.toLocaleString()}
                      sub="Active and effective today"
                      plain
                    />
                    <MoneyTile
                      label="Upcoming schedule"
                      value={canPlanProfile ? `${formatHours(schedule.summary.pendingHours)} h` : "Restricted"}
                      sub={canPlanProfile ? `${schedule.summary.pendingSessions} pending session${schedule.summary.pendingSessions === 1 ? "" : "s"}` : "Planning access required"}
                      plain
                    />
                  </div>
                </section>
                {!planningOnly && report && (canSeeBilledAmounts || canSeeEmployeeAmounts || canSeeAgencySpread) ? (
                  <Card title="Recorded value" description="Transaction-backed totals. Future sessions are excluded.">
                    <div className="grid gap-3 p-5 sm:grid-cols-3">
                      {canSeeBilledAmounts ? <MoneyTile label="Funder billed" value={formatMoney(report.agencyGross)} /> : null}
                      {canSeeEmployeeAmounts ? <MoneyTile label="Employee base" value={formatMoney(report.internalAmount)} sub="Calculated base, not proof of payment" /> : null}
                      {canSeeAgencySpread ? <MoneyTile label="Agency spread" value={formatMoney(payment.agencyAdditional)} sub="Not Employee pay" /> : null}
                    </div>
                  </Card>
                ) : null}
              </div>
            ),
          },
          {
            id: "activity",
            label: "Actual Activity",
            content: (
              <div className="space-y-6">
                <section className="card px-5 py-5">
                  <p className="eyebrow">Actual, recorded activity</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <MoneyTile label="Physical hours" value={`${formatHours(planningOnly ? planningSummary?.recordedServiceHours ?? "0" : report?.physicalHours ?? "0")} h`} sub="Time worked; each group session counted once" plain />
                    <MoneyTile label="Billed allocation hours" value={canSeeHours && report ? `${formatHours(report.allocationHours)} h` : "Restricted"} sub="Each participant receives their service allocation" plain />
                    <MoneyTile label="Group sessions" value={(planningOnly ? planningSummary?.groupSessions ?? 0 : report?.groupSessions ?? 0).toLocaleString()} plain />
                  </div>
                  {!hasActualActivity ? <p className="mt-4 text-sm text-[var(--color-ink-soft)]">No actual service or transaction activity is recorded.</p> : null}
                </section>
                {monthly.length > 0 ? (
                  <Card title="Actual activity by month" description="Route columns classify Employee base; they do not prove that a payment cleared.">
                    <Table head={<><Th>Month</Th>{canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Employee base</Th> : null}{canSeeEmployeeAmounts && attributionAvailable ? <><Th numeric>Direct-Pay base</Th><Th numeric>Agency-Routed base</Th></> : null}<Th numeric>Transactions</Th></>}>
                      {monthly.map((month) => (
                        <Tr key={month.month ?? "undated"}>
                          <Td><span className="tnum">{month.month ?? "Undated"}</span></Td>
                          {canSeeBilledAmounts ? <Td numeric><Money value={month.agencyGross} /></Td> : null}
                          {canSeeEmployeeAmounts ? <Td numeric><Money value={month.internalAmount} /></Td> : null}
                          {canSeeEmployeeAmounts && attributionAvailable ? <><Td numeric><Money value={month.paidToEmployee} /></Td><Td numeric><Money value={month.payableByAgency} /></Td></> : null}
                          <Td numeric className="tnum">{month.transactionCount}</Td>
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {individualsServed.length > 0 ? (
                  <Card title="Actual individuals" description="People present in this Employee's transaction history.">
                    <Table head={<><Th>Person</Th>{canSeeHours ? <Th numeric>Billed hours</Th> : null}<Th numeric>Transactions</Th>{canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}{canSeeTransactions ? <Th>Open</Th> : null}</>}>
                      {individualsServed.map((row) => (
                        <Tr key={row.id}>
                          <Td><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/individuals/${row.id}`}>{row.displayName}</Link></Td>
                          {canSeeHours ? <Td numeric><Hours value={row.allocationHours} /></Td> : null}
                          <Td numeric>{row.transactionCount}</Td>
                          {canSeeBilledAmounts ? <Td numeric><Money value={row.agencyGross} /></Td> : null}
                          {canSeeTransactions ? <Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, individualId: row.id })}>Rows →</Link></Td> : null}
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {usageByProgram.length > 0 ? (
                  <Card title="Actual programs" action={canSeeTransactions ? <ButtonLink href={txLink({ employeeId: id })} variant="secondary">All rows →</ButtonLink> : undefined}>
                    <Table head={<><Th>Program</Th>{canSeeHours ? <><Th numeric>Physical hours</Th><Th numeric>Billed hours</Th></> : null}<Th numeric>Transactions</Th>{canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}{canSeeEmployeeAmounts ? <Th numeric>Employee base</Th> : null}</>}>
                      {usageByProgram.map((row) => (
                        <Tr key={row.programCode}>
                          <Td>{canSeeTransactions ? <Link className="font-medium text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, program: row.programName })}>{row.programName}</Link> : row.programName}</Td>
                          {canSeeHours ? <><Td numeric><Hours value={row.physicalHours} /></Td><Td numeric><Hours value={row.allocationHours} /></Td></> : null}
                          <Td numeric>{row.transactionCount}</Td>
                          {canSeeBilledAmounts ? <Td numeric><Money value={row.agencyGross} /></Td> : null}
                          {canSeeEmployeeAmounts ? <Td numeric><Money value={row.internalAmount} /></Td> : null}
                        </Tr>
                      ))}
                    </Table>
                  </Card>
                ) : null}
                {recent.rows.length > 0 ? (
                  <Card title="Recent actual transactions" action={canSeeTransactions ? <ButtonLink href={txLink({ employeeId: id })} variant="secondary">Open ledger →</ButtonLink> : undefined}>
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
                    <div className="mb-2 flex items-baseline justify-between gap-2"><h2 className="text-lg font-semibold">Complete transaction ledger</h2><span className="text-xs text-[var(--color-text-soft)]">{gridRows.length.toLocaleString()} source rows</span></div>
                    <TransactionsGrid rows={gridRows} canManage={canEdit} visibility={transactionVisibility} canSeeBudgets={canSeeBudgets} contextLabel={null} />
                  </section>
                ) : null}
              </div>
            ),
          },
          {
            id: "staffing",
            label: "Staffing",
            content: (
              <div className="space-y-6">
                <Card title="Current assignments" description="Active assignments whose dates include today.">
                  {assignments.length > 0 ? (
                    <Table head={<><Th>Person</Th><Th>Program</Th><Th>Effective dates</Th>{canSeeHours ? <Th numeric>Allowed hours</Th> : null}</>}>
                      {assignments.map((assignment) => (
                        <Tr key={assignment.id}>
                          <Td><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/individuals/${assignment.individualId}`}>{assignment.individualName}</Link></Td>
                          <Td><Plain value={assignment.programName} /></Td>
                          <Td><span className="tnum">{assignment.startDate ?? "Any start"}</span> to <span className="tnum">{assignment.endDate ?? "open"}</span></Td>
                          {canSeeHours ? <Td numeric>{assignment.allowedHours ? <Hours value={assignment.allowedHours} /> : "—"}</Td> : null}
                        </Tr>
                      ))}
                    </Table>
                  ) : <div className="px-5 py-7 text-sm text-[var(--color-ink-soft)]">No current assignments.</div>}
                </Card>
                {canPlanProfile ? (
                  <>
                    <Card title="Upcoming schedule" description="Future pending sessions only; actual work remains in Actual Activity." action={<ButtonLink href={`/schedule?view=calendar&employeeId=${id}`} variant="secondary">Open calendar →</ButtonLink>}>
                      {schedule.upcoming.length > 0 ? (
                        <Table head={<><Th>Date</Th><Th>Time</Th><Th>Program</Th><Th>Individuals</Th><Th numeric>Hours</Th><Th>Open</Th></>}>
                          {schedule.upcoming.map((session) => (
                            <Tr key={session.id}>
                              <Td className="tnum">{profileDate(session.sessionDate)}</Td>
                              <Td className="tnum">{session.startTime ?? "Time not set"}</Td>
                              <Td>{session.programName}</Td>
                              <Td>{session.individualNames.join(", ") || "Unassigned"}{session.isGroup ? <p className="text-xs text-[var(--color-ink-faint)]">Group · {session.groupSize}</p> : null}</Td>
                              <Td numeric><Hours value={session.durationHours} /></Td>
                              <Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={scheduleHref(id, session.id, session.sessionDate)}>Visit →</Link></Td>
                            </Tr>
                          ))}
                        </Table>
                      ) : <div className="px-5 py-7 text-sm text-[var(--color-ink-soft)]">No upcoming pending sessions.</div>}
                    </Card>
                    <section>
                      <div className="mb-3"><p className="eyebrow">Availability</p><h2 className="mt-1 text-lg font-semibold">Weekly hours and time off</h2></div>
                      <EmployeeAvailabilityManager employees={[{ id, label: employee.displayName }]} initialEmployeeId={id} today={today} canManage={canPlanProfile} />
                    </section>
                  </>
                ) : (
                  <section className="card px-5 py-5"><h2 className="font-semibold">Schedule and availability</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Planning access is required to see upcoming individuals, working hours, or time off.</p></section>
                )}
              </div>
            ),
          },
          {
            id: "money",
            label: "Money",
            content: hasMoneyAccess ? (
              <div className="space-y-6">
                {canSeeEmployeeAmounts ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <Card title="Direct-Pay" description="The funder check is routed to the Employee.">
                      <div className="p-5"><MoneyTile label="Employee base under this route" value={formatMoney(payment.paidToEmployee)} sub="Classification only — not proof the check was issued, received, or cleared" /><p className="mt-3 text-sm"><Link className="font-semibold text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, recipient: "employee" })}>Open Direct-Pay source rows →</Link></p></div>
                    </Card>
                    <Card title="Agency-Routed" description="The funder payment is routed to the Agency.">
                      <div className="p-5"><MoneyTile label="Employee base under this route" value={formatMoney(payment.payableByAgency)} sub="Calculated Employee base — not proof the Agency paid the Employee" /><p className="mt-3 text-sm"><Link className="font-semibold text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, recipient: "excellent_staffing" })}>Open Agency-Routed source rows →</Link></p></div>
                    </Card>
                  </div>
                ) : null}
                {canSeeEmployeeAmounts && dec(payment.unknownRecipient).greaterThan(0) ? (
                  <section className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm"><span className="font-semibold">Routing still needed:</span> {formatMoney(payment.unknownRecipient)} of Employee base is not yet classified as Direct-Pay or Agency-Routed.</section>
                ) : null}
                {canSeeSettlements ? (
                  <Card title="Settlement balances" description="Calculated obligations and recorded settlement events, kept separate by money direction." action={<ButtonLink href={`/settlements?employeeId=${id}`} variant="secondary">Open payments →</ButtonLink>}>
                    <div className="grid gap-4 p-5 xl:grid-cols-2"><FlowSummary flow="Direct-Pay" summary={money.directPay} /><FlowSummary flow="Agency-Routed" summary={money.agencyRouted} /></div>
                  </Card>
                ) : null}
                {canSeeEmployeeDeals ? (
                  <Card title="Current deal" description={currentDeal ? `Effective ${currentDeal.effectiveFrom}${currentDeal.effectiveTo ? ` to ${currentDeal.effectiveTo}` : " onward"}` : "No active deal is configured."}>
                    {currentDeal ? (
                      <div className="grid gap-4 p-5 lg:grid-cols-2">
                        <div className="border-l-4 border-[var(--color-info)] pl-3"><p className="font-semibold">Direct-Pay give-back</p><p className="mt-1 text-sm text-[var(--color-ink-soft)]">{currentDeal.directRule === "keep_all" ? "Employee keeps the whole check net; nothing is owed back." : currentDeal.directRule === "giveback_all" ? "Employee gives the Agency the whole check net." : `Employee gives the Agency ${directPercent}% of the whole check net.`}</p><p className="mt-1 text-xs text-[var(--color-ink-faint)]">Calculated from actual check net, never funder billed, gross, or taxes.</p></div>
                        <div className="border-l-4 border-[var(--color-success)] pl-3"><p className="font-semibold">Agency-Routed payout</p><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Default Agency cut is {agencyPercent}% of Employee base; Employee share is {dec(1).minus(currentDeal.agencyCutPercent).times(100).toDecimalPlaces(2).toString()}%.</p><p className="mt-1 text-xs text-[var(--color-ink-faint)]">Person-specific rules take priority. Agency spread stays outside the deal.</p></div>
                      </div>
                    ) : <div className="px-5 py-7 text-sm text-[var(--color-ink-soft)]">Set a deal before calculating route-specific obligations.</div>}
                  </Card>
                ) : null}
                {canSeeCheckNet || canSeeTaxes ? (
                  <Card title="Canonical payroll checks" description="Actual check facts. Funder-billed revenue is never substituted for check gross.">
                    {checks.length > 0 ? (
                      <Table head={<><Th>Check</Th><Th>Service period</Th>{canSeeCheckNet ? <><Th numeric>Actual gross</Th><Th numeric>Actual net</Th></> : null}{canSeeTaxes ? <Th numeric>Taxes</Th> : null}<Th>Status</Th><Th numeric>Linked rows</Th></>}>
                        {checks.map((check) => {
                          const checkMonth = (check.periodBegin ?? check.checkDate ?? check.periodEnd ?? today).slice(0, 7);
                          return (
                            <Tr key={check.id}>
                              <Td><Link className="font-semibold text-[var(--color-primary)] hover:underline" href={collectionsPayrollCheckFocusHref({ payrollCheckId: check.id, month: checkMonth })}>{check.checkNumber ?? "No number"}</Link><p className="tnum text-xs text-[var(--color-ink-faint)]">{profileDate(check.checkDate)}</p></Td>
                              <Td><span className="tnum">{check.periodBegin ?? "—"}</span> to <span className="tnum">{check.periodEnd ?? "—"}</span></Td>
                              {canSeeCheckNet ? <><Td numeric><Money value={check.actualGross} /></Td><Td numeric><Money value={check.actualNet} /></Td></> : null}
                              {canSeeTaxes ? <Td numeric><Money value={check.taxWithheld} /></Td> : null}
                              <Td className="capitalize">{check.verificationStatus}</Td>
                              <Td numeric>{check.linkedTransactions}</Td>
                            </Tr>
                          );
                        })}
                      </Table>
                    ) : <div className="px-5 py-7 text-sm text-[var(--color-ink-soft)]">No canonical payroll checks are recorded.</div>}
                    <div className="grid gap-3 border-t border-[var(--color-rule)] p-5 sm:grid-cols-3">
                      {canSeeCheckNet ? <><MoneyTile label="Verified gross" value={formatMoney(withholding.gross)} /><MoneyTile label="Verified net" value={formatMoney(withholding.net)} /></> : null}
                      {canSeeTaxes ? <MoneyTile label="Verified taxes" value={formatMoney(withholding.withheld)} sub={`${withholding.checks} verified check${withholding.checks === 1 ? "" : "s"}`} /> : null}
                    </div>
                  </Card>
                ) : null}
                {canSeeSettlements && money.roots.length > 0 ? (
                  <Card title="Open-item detail">
                    <Table head={<><Th>Flow</Th><Th>Check / service date</Th><Th>Direction</Th><Th numeric>Calculated</Th><Th numeric>Recorded</Th><Th numeric>Balance</Th><Th>State</Th></>}>
                      {money.roots.map((root) => <Tr key={root.id}><Td>{root.flow === "direct_employee" ? "Direct-Pay" : "Agency-Routed"}</Td><Td><Plain value={root.checkNumber} /><p className="tnum text-xs text-[var(--color-ink-faint)]">{profileDate(root.serviceDate)}</p></Td><Td>{root.direction === "receivable" ? "Employee → Agency" : root.direction === "payable" ? "Agency → Employee" : "Reserve"}</Td><Td numeric><Money value={root.target} /></Td><Td numeric><Money value={root.applied} /></Td><Td numeric><Money value={root.balance} /></Td><Td className="capitalize">{root.state.replace(/_/g, " ")}</Td></Tr>)}
                    </Table>
                  </Card>
                ) : null}
                {canSeeSettlements && money.events.length > 0 ? (
                  <Card title="Recent payments and adjustments">
                    <Table head={<><Th>Date</Th><Th>Flow</Th><Th>Event</Th><Th numeric>Amount</Th><Th>Reference</Th></>}>
                      {money.events.map((event) => <Tr key={event.id}><Td className="tnum">{profileDate(event.occurredOn)}</Td><Td>{event.flow === "direct_employee" ? "Direct-Pay" : "Agency-Routed"}</Td><Td className="capitalize">{event.eventType.replace(/_/g, " ")}{event.reversed ? <p className="text-xs text-[var(--color-danger)]">Reversed</p> : null}</Td><Td numeric><Money value={event.amount} /></Td><Td><Plain value={event.reference ?? event.note} /></Td></Tr>)}
                    </Table>
                  </Card>
                ) : null}
              </div>
            ) : <section className="card px-5 py-5"><h2 className="font-semibold">Employee money is restricted</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Your access includes staffing facts but not checks, pay, taxes, deals, or balances.</p></section>,
          },
          {
            id: "more",
            label: "More",
            content: (
              <div className="space-y-6">
                <section className="card px-5 py-5">
                  <h2 className="text-base font-semibold">Profile details</h2>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div><dt className="eyebrow">Status</dt><dd className="mt-1 text-sm font-medium capitalize">{employee.status}</dd></div>
                    {report ? <div><dt className="eyebrow">Rate exceptions</dt><dd className="tnum mt-1 text-sm font-medium">{report.rateExceptions}</dd></div> : null}
                  </dl>
                  {groupGap && report ? <p className="mt-5 border-t border-[var(--color-rule)] pt-4 text-sm text-[var(--color-ink-soft)]">Physical hours are <span className="tnum font-medium text-[var(--color-ink)]">{formatHours(report.physicalHours)}</span>; billed allocation hours are <span className="tnum font-medium text-[var(--color-ink)]">{formatHours(report.allocationHours)}</span>. Group sessions count physical time once while crediting each participant&apos;s full service allocation.</p> : null}
                  {!planningOnly && employeeNotes ? <div className="mt-5 border-t border-[var(--color-rule)] pt-4"><p className="eyebrow mb-2">Notes</p><p className="whitespace-pre-wrap text-sm">{employeeNotes}</p></div> : null}
                </section>
                {canSeeEmployeeDeals && deals.length > 0 ? (
                  <Card title="Deal history">
                    <Table head={<><Th>Dates</Th><Th>Direct-Pay</Th><Th>Agency-Routed</Th><Th numeric>Revision</Th><Th>Status</Th></>}>
                      {deals.map((deal) => <Tr key={deal.id}><Td><span className="tnum">{deal.effectiveFrom}</span>{deal.effectiveTo ? <span className="tnum text-[var(--color-ink-faint)]"> to {deal.effectiveTo}</span> : null}</Td><Td>{deal.directRule === "keep_all" ? "Keep net" : deal.directRule === "giveback_all" ? "Give all net" : `${dec(deal.directPercent).times(100).toDecimalPlaces(2).toString()}% of net`}</Td><Td>{dec(deal.agencyCutPercent).times(100).toDecimalPlaces(2).toString()}% of Employee base to Agency by default</Td><Td numeric>{deal.revision}</Td><Td className="capitalize">{deal.status}</Td></Tr>)}
                    </Table>
                  </Card>
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

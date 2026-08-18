import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getEmployeeReport } from "@/lib/data/queries";
import { isUuid, listTransactions, listPrograms } from "@/lib/data/app-queries";
import {
  getEmployeePaymentSummary,
  getEmployeeIndividuals,
  getEmployeeUsageByProgram,
  getEmployeeMonthlyPayments,
  getEmployeeSchedule,
} from "@/lib/data/employee-queries";
import { listSeriesForEmployee } from "@/lib/data/schedule-queries";
import { txLink } from "@/lib/nav/tx-link";
import { getEmployee } from "@/lib/manage/employees";
import { listAssignments } from "@/lib/manage/assignments";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import {
  Card, Table, Th, Td, Tr, Money, Hours, Plain, Badge, EmptyState, ErrorPanel, PageHeader, StatTile, ButtonLink,
} from "@/components/ui";
import { BigStat } from "@/components/ui-viz";
import { TabPanels, type TabPanel } from "@/components/ui-client";
import { CreateButton, ActionButton, Field, TextAreaField, SelectField } from "@/components/manage/client";
import { dec, formatHours, formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employee — Ahivim Budget Management" };

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const { id } = await params;
  const initialTab = typeof (await searchParams).tab === "string" ? ((await searchParams).tab as string) : undefined;
  if (!isUuid(id)) notFound();

  const result = await withDb(async (pool) => {
    const employee = await getEmployee(pool, id);
    if (!employee) return null;
    const [
      report,
      assignments,
      recent,
      programs,
      individuals,
      payment,
      individualsServed,
      usageByProgram,
      monthly,
      schedule,
      series,
    ] = await Promise.all([
      getEmployeeReport(pool, id),
      listAssignments(pool, { employeeId: id, includeInactive: true }),
      listTransactions(pool, { employeeId: id, limit: 25 }),
      listPrograms(pool),
      listIndividualsManaged(pool, { status: "active" }),
      getEmployeePaymentSummary(pool, id),
      getEmployeeIndividuals(pool, id),
      getEmployeeUsageByProgram(pool, id),
      getEmployeeMonthlyPayments(pool, id),
      getEmployeeSchedule(pool, id),
      listSeriesForEmployee(pool, id),
    ]);
    return {
      employee, report, assignments, recent, programs, individuals,
      payment, individualsServed, usageByProgram, monthly, schedule, series,
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
    employee, report, assignments, recent, programs, individuals,
    payment, individualsServed, usageByProgram, monthly, schedule, series,
  } = result.data;

  const programOptions = programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }));
  const individualOptions = individuals.map((i) => ({ value: i.id, label: i.displayName }));

  // Attribution is only meaningful once the payment-attribution back-fill has
  // run. With transactions present but nothing attributed, the split would read
  // as an all-"unknown" $0 — so we say "not available" instead of misleading.
  const attributionAvailable = payment.transactionCount === 0 || payment.attributedCount > 0;
  const hasUnknown = dec(payment.unknownRecipient).greaterThan(0);

  // Yearly rollup, summed decimal-safe from the monthly rows.
  const yearMap = new Map<
    string,
    { agencyGross: string; internalAmount: string; paidToEmployee: string; payableByAgency: string; checks: number; transactions: number }
  >();
  for (const m of monthly) {
    const year = m.month ? m.month.slice(0, 4) : "Undated";
    const prev = yearMap.get(year) ?? {
      agencyGross: "0", internalAmount: "0", paidToEmployee: "0", payableByAgency: "0", checks: 0, transactions: 0,
    };
    yearMap.set(year, {
      agencyGross: dec(prev.agencyGross).plus(dec(m.agencyGross)).toString(),
      internalAmount: dec(prev.internalAmount).plus(dec(m.internalAmount)).toString(),
      paidToEmployee: dec(prev.paidToEmployee).plus(dec(m.paidToEmployee)).toString(),
      payableByAgency: dec(prev.payableByAgency).plus(dec(m.payableByAgency)).toString(),
      checks: prev.checks + m.checkCount,
      transactions: prev.transactions + m.transactionCount,
    });
  }
  const yearlyRows = [...yearMap.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

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

  /* ------------------------------------------------------------------ */
  /* Overview panel                                                     */
  /* ------------------------------------------------------------------ */
  const overviewPanel = (
    <>
      {report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <BigStat
              label="Physical hours"
              value={`${formatHours(report.physicalHours)} h`}
              hint="Time present — a group session counts once"
            />
            <BigStat
              label="Billed hours"
              value={`${formatHours(report.allocationHours)} h`}
              tone="info"
              hint="Ledger hours — reconciles to Transactions"
            />
            <BigStat
              label="Individuals served"
              value={report.individualsServed.toLocaleString()}
              hint={`${report.groupSessions.toLocaleString()} group sessions`}
            />
            <BigStat
              label="Programs"
              value={report.programs.length.toLocaleString()}
              hint={report.programs.length ? report.programs.join(", ") : "None recorded"}
            />
          </div>

          <p className="mt-3 max-w-prose text-xs text-[var(--color-ink-faint)]">
            Physical and allocation hours are deliberately separate. A 13-hour session with three
            individuals is 13 physical hours and 39 allocation hours; reporting 39 as hours worked
            would overstate this employee&rsquo;s time threefold. Physical hours are what the employee
            actually worked; allocation hours are what the individuals collectively drew down.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile label="Agency total" value={formatMoney(report.agencyGross)} hint="Billed to the funder" />
            <StatTile label="Employee amount" value={formatMoney(report.internalAmount)} hint="Owed to the employee" />
            <StatTile
              label="Rate exceptions"
              value={report.rateExceptions.toLocaleString()}
              hint={report.rateExceptions ? "Imported rates preserved exactly" : "None on this employee's rows"}
              tone={report.rateExceptions ? "warn" : "neutral"}
            />
            <StatTile
              label="Paid directly to employee"
              value={attributionAvailable ? formatMoney(payment.paidToEmployee) : undefined}
              unavailable={attributionAvailable ? undefined : "Run payment attribution to split direct vs. agency-routed pay."}
              hint="payment_recipient = employee"
            />
            <StatTile
              label="Payable by the agency"
              value={attributionAvailable ? formatMoney(payment.payableByAgency) : undefined}
              unavailable={attributionAvailable ? undefined : "Run payment attribution to split direct vs. agency-routed pay."}
              hint="Excellent Staffing pays the employee"
            />
            <StatTile
              label="Agency markup"
              value={formatMoney(payment.agencyAdditional)}
              hint="Agency total above the internal amount"
            />
          </div>

          {attributionAvailable && hasUnknown ? (
            <p className="mt-3 max-w-prose text-xs text-[var(--color-ink-faint)]">
              {formatMoney(payment.unknownRecipient)} of internal pay could not be attributed to a recipient
              (no pay-to name, or a name that matched neither the employee nor an agency marker). See the Payments tab.
            </p>
          ) : null}

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
            <p>This employee has no transactions yet, so there are no hours or payments to report.</p>
          </EmptyState>
        </Card>
      )}

      <Card title="Notes" className="mt-6">
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
    </>
  );

  /* ------------------------------------------------------------------ */
  /* Transactions panel (billed activity)                               */
  /* ------------------------------------------------------------------ */
  const transactionsPanel = (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-[var(--color-ink-soft)]">
          What was actually billed for this employee, summarised by program. Physical hours count each session
          once; billed hours are the ledger hours and reconcile to Transactions. Click a program to open its rows.
        </p>
        <ButtonLink href={txLink({ employeeId: id })} variant="secondary">Open all billed rows →</ButtonLink>
      </div>

      {usageByProgram.length > 0 ? (
        <Card title="Billed by program" description="Physical time present vs. billed hours and money. Billed figures match the ledger.">
          <Table
            head={
              <>
                <Th>Program</Th>
                <Th numeric>Physical h</Th>
                <Th numeric>Billed h</Th>
                <Th numeric>Transactions</Th>
                <Th numeric>Agency total</Th>
                <Th numeric>Internal</Th>
                <Th>Open</Th>
              </>
            }
          >
            {usageByProgram.map((row) => (
              <Tr key={row.programCode}>
                <Td>
                  <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={txLink({ employeeId: id, program: row.programName })}>{row.programName}</Link>
                  <p className="text-xs text-[var(--color-ink-faint)]">{row.programCode}</p>
                </Td>
                <Td numeric><Hours value={row.physicalHours} /></Td>
                <Td numeric><Hours value={row.allocationHours} /></Td>
                <Td numeric className="tnum">{row.transactionCount}</Td>
                <Td numeric><Money value={row.agencyGross} /></Td>
                <Td numeric><Money value={row.internalAmount} /></Td>
                <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, program: row.programName })}>rows →</Link></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : (
        <EmptyState title="No transactions recorded" />
      )}

      <div className="mt-6">
        <Card
          title="Recent transactions"
          description="Most recent 25 rows for this employee. Open the full, filterable ledger for all of them."
          action={<ButtonLink href={txLink({ employeeId: id })}>Full ledger →</ButtonLink>}
        >
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
                    {t.checkNumber ? (
                      <Link className="font-medium text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, checkNumber: t.checkNumber })}><Plain value={t.checkNumber} /></Link>
                    ) : (
                      <Plain value={t.checkNumber} />
                    )}
                    <p className="text-xs text-[var(--color-ink-faint)]"><Plain value={t.checkDate} /></p>
                  </Td>
                  <Td>{t.individualId ? <Link className="text-[var(--color-primary)] hover:underline" href={`/individuals/${t.individualId}`}><Plain value={t.individual} /></Link> : <Plain value={t.individual} />}</Td>
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

  /* ------------------------------------------------------------------ */
  /* Individuals panel (served + assignments)                           */
  /* ------------------------------------------------------------------ */
  const individualsPanel = (
    <>
      <Card
        title="Individuals served"
        description="Who this employee actually billed for, from the ledger. Billed hours and money reconcile to Transactions."
      >
        {individualsServed.length === 0 ? (
          <EmptyState title="No individuals served yet">
            <p>Once this employee has committed transactions, everyone they served appears here with hours.</p>
          </EmptyState>
        ) : (
          <Table
            caption="Individuals this employee has served"
            head={<><Th>Individual</Th><Th numeric>Billed h</Th><Th numeric>Transactions</Th><Th numeric>Agency total</Th><Th numeric>Internal</Th><Th>Open</Th></>}
          >
            {individualsServed.map((row) => (
              <Tr key={row.id}>
                <Td>
                  <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${row.id}`}>
                    {row.displayName}
                  </Link>
                </Td>
                <Td numeric><Hours value={row.allocationHours} /></Td>
                <Td numeric className="tnum">{row.transactionCount}</Td>
                <Td numeric><Money value={row.agencyGross} /></Td>
                <Td numeric><Money value={row.internalAmount} /></Td>
                <Td><Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ employeeId: id, individualId: row.id })}>rows →</Link></Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>

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
                    <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${a.individualId}`}>
                      {a.individualName}
                    </Link>
                  </Td>
                  <Td><Plain value={a.programName} /></Td>
                  <Td>
                    <span className="tnum">{a.startDate ?? "—"}</span>
                    <span className="text-[var(--color-ink-faint)]"> → </span>
                    <span className="tnum">{a.endDate ?? "open"}</span>
                  </Td>
                  <Td numeric><Hours value={a.allowedHours} /></Td>
                  <Td><Badge value={a.status} /></Td>
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
    </>
  );

  /* ------------------------------------------------------------------ */
  /* Schedule panel                                                     */
  /* ------------------------------------------------------------------ */
  const schedulePanel = (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-[var(--color-ink-soft)]">
          Delivered work (completed sessions) set against what is still scheduled (pending). Scheduled hours are
          never folded into billed hours until the session is delivered and reconciled.
        </p>
        <ButtonLink href={`/schedule?employeeId=${id}`} variant="secondary">Open calendar</ButtonLink>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Scheduled sessions"
          value={schedule.summary.pendingSessions.toLocaleString()}
          hint={`${formatHours(schedule.summary.pendingHours)} h pending`}
        />
        <StatTile
          label="Scheduled hours"
          value={`${formatHours(schedule.summary.pendingHours)} h`}
          hint="Pending, not yet billed"
        />
        <StatTile
          label="Delivered sessions"
          value={schedule.summary.completedSessions.toLocaleString()}
          hint={`${formatHours(schedule.summary.completedHours)} h completed`}
          tone="good"
        />
        <StatTile
          label="Cancelled / no-show"
          value={(schedule.summary.cancelledSessions + schedule.summary.noShowSessions).toLocaleString()}
          hint={`${schedule.summary.cancelledSessions} cancelled · ${schedule.summary.noShowSessions} no-show`}
        />
      </div>

      <div className="mt-6">
        <Card
          title="Upcoming pending sessions"
          description="Planned sessions from today onward that will consume budget once delivered."
          action={<ButtonLink href={`/schedule?employeeId=${id}`}>Open calendar</ButtonLink>}
        >
          {schedule.upcoming.length === 0 ? (
            <EmptyState title="Nothing scheduled">
              <p>There are no pending sessions for this employee from today onward.</p>
            </EmptyState>
          ) : (
            <Table
              caption="Upcoming pending sessions"
              head={<><Th>Date</Th><Th>Program</Th><Th>Individuals</Th><Th numeric>Hours</Th><Th numeric>Expected internal</Th><Th>Status</Th></>}
            >
              {schedule.upcoming.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <span className="tnum">{s.sessionDate}</span>
                    {s.startTime ? <p className="text-xs text-[var(--color-ink-faint)]">{s.startTime}</p> : null}
                  </Td>
                  <Td>
                    {s.programName}
                    {s.isGroup ? <p className="text-xs text-[var(--color-ink-faint)]">Group of {s.groupSize}</p> : null}
                  </Td>
                  <Td>
                    {s.individualNames.length ? s.individualNames.join(", ") : <span className="text-[var(--color-ink-faint)]">—</span>}
                  </Td>
                  <Td numeric><Hours value={s.durationHours} /></Td>
                  <Td numeric><Money value={s.expectedInternalAmount} /></Td>
                  <Td><Badge value={s.status} /></Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {series.length > 0 ? (
        <div className="mt-6">
          <Card title="Recurring series" description="Templates that materialise into scheduled sessions.">
            <Table
              caption="Recurring schedule series for this employee"
              head={<><Th>Program</Th><Th>Frequency</Th><Th>Dates</Th><Th numeric>Occurrences</Th><Th>Status</Th></>}
            >
              {series.map((s) => (
                <Tr key={s.id}>
                  <Td><Plain value={s.programName} /></Td>
                  <Td>
                    {s.interval > 1 ? `Every ${s.interval} ` : ""}
                    {s.frequency}
                  </Td>
                  <Td>
                    <span className="tnum">{s.startDate}</span>
                    <span className="text-[var(--color-ink-faint)]"> → </span>
                    <span className="tnum">{s.endDate}</span>
                  </Td>
                  <Td numeric className="tnum">{s.occurrences}</Td>
                  <Td><Badge value={s.status} /></Td>
                </Tr>
              ))}
            </Table>
          </Card>
        </div>
      ) : null}
    </>
  );

  /* ------------------------------------------------------------------ */
  /* Payments panel                                                     */
  /* ------------------------------------------------------------------ */
  const paymentsPanel = (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-[var(--color-ink-soft)]">
          What the employee earns (the internal amount) and who pays it. When Excellent Staffing is the payee,
          the agency receives the gross and is responsible for paying the employee; when the employee is the payee
          they are paid directly.
        </p>
        <ButtonLink href={`/reports/employee-payable`} variant="secondary">Employee payable report</ButtonLink>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Agency total" value={formatMoney(payment.agencyGross)} hint={`${payment.checkCount} distinct checks`} />
        <StatTile label="Internal (employee) amount" value={formatMoney(payment.internalAmount)} hint="Total owed to the employee" />
        <StatTile
          label="Paid directly to employee"
          value={attributionAvailable ? formatMoney(payment.paidToEmployee) : undefined}
          unavailable={attributionAvailable ? undefined : "Payment attribution has not been run for these rows."}
          tone="good"
        />
        <StatTile
          label="Payable by the agency"
          value={attributionAvailable ? formatMoney(payment.payableByAgency) : undefined}
          unavailable={attributionAvailable ? undefined : "Payment attribution has not been run for these rows."}
          hint="Excellent Staffing"
        />
      </div>

      {attributionAvailable && hasUnknown ? (
        <p className="mt-3 max-w-prose text-xs text-[var(--color-ink-faint)]">
          {formatMoney(payment.unknownRecipient)} could not be attributed to a recipient and is excluded from the
          direct and agency-payable figures above.
        </p>
      ) : null}
      {!attributionAvailable && payment.transactionCount > 0 ? (
        <div className="mt-4">
          <ErrorPanel title="Payment recipients not yet attributed">
            <p>
              These transactions carry an internal amount but no recipient classification, so the direct-vs-agency
              split cannot be shown. Run the payment-attribution back-fill to populate it.
            </p>
          </ErrorPanel>
        </div>
      ) : null}

      <div className="mt-6">
        <Card title="Monthly totals" description="By service period (falling back to check date). Newest first.">
          {monthly.length === 0 ? (
            <EmptyState title="No payments recorded" />
          ) : (
            <Table
              caption="Monthly payment totals for this employee"
              head={<><Th>Month</Th><Th numeric>Agency total</Th><Th numeric>Internal</Th><Th numeric>Paid directly</Th><Th numeric>Payable by agency</Th><Th numeric>Checks</Th></>}
            >
              {monthly.map((m) => (
                <Tr key={m.month ?? "undated"}>
                  <Td><span className="tnum">{m.month ?? "Undated"}</span></Td>
                  <Td numeric><Money value={m.agencyGross} /></Td>
                  <Td numeric><Money value={m.internalAmount} /></Td>
                  <Td numeric>{attributionAvailable ? <Money value={m.paidToEmployee} /> : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                  <Td numeric>{attributionAvailable ? <Money value={m.payableByAgency} /> : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                  <Td numeric className="tnum">{m.checkCount}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {yearlyRows.length > 0 ? (
        <div className="mt-6">
          <Card title="Yearly totals" description="Rolled up from the monthly figures.">
            <Table
              caption="Yearly payment totals for this employee"
              head={<><Th>Year</Th><Th numeric>Agency total</Th><Th numeric>Internal</Th><Th numeric>Paid directly</Th><Th numeric>Payable by agency</Th><Th numeric>Checks</Th></>}
            >
              {yearlyRows.map(([year, y]) => (
                <Tr key={year}>
                  <Td><span className="tnum font-medium">{year}</span></Td>
                  <Td numeric><Money value={y.agencyGross} /></Td>
                  <Td numeric><Money value={y.internalAmount} /></Td>
                  <Td numeric>{attributionAvailable ? <Money value={y.paidToEmployee} /> : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                  <Td numeric>{attributionAvailable ? <Money value={y.payableByAgency} /> : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                  <Td numeric className="tnum">{y.checks}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
        </div>
      ) : null}
    </>
  );

  const panels: TabPanel[] = [
    { id: "overview", label: "Overview", content: overviewPanel },
    { id: "transactions", label: "Transactions", badge: usageByProgram.length || undefined, content: transactionsPanel },
    { id: "individuals", label: "Individuals", badge: individualsServed.length || assignments.length || undefined, content: individualsPanel },
    { id: "schedule", label: "Schedule", badge: schedule.summary.pendingSessions || undefined, content: schedulePanel },
    { id: "payments", label: "Payments", badge: monthly.length || undefined, content: paymentsPanel },
  ];

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

      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <Badge value={employee.status} />
        <span className="text-[var(--color-ink-faint)]">
          {report
            ? `${formatHours(report.physicalHours)} physical hours across ${report.individualsServed} individual${report.individualsServed === 1 ? "" : "s"}`
            : "No billed activity recorded yet."}
        </span>
        {employee.externalRef ? <span className="text-[var(--color-ink-faint)]">Ref: {employee.externalRef}</span> : null}
      </div>

      <TabPanels panels={panels} initialId={initialTab} paramKey="tab" />

      <p className="mt-6 text-xs text-[var(--color-ink-faint)]">
        <Badge value="valid" label="Note" /> Physical hours are time the employee was present; allocation hours sum
        each served individual&rsquo;s entitlement. On a group session every participant is credited the full session
        hours, so allocation hours exceed physical hours — the money is what divides.
      </p>
    </>
  );
}

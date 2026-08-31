import Link from "next/link";
import {
  BadgeDollarSign,
  Building2,
  CalendarDays,
  ChevronDown,
  Clock3,
  Download,
  Landmark,
  Printer,
  ReceiptText,
  Settings2,
  ShieldCheck,
  UserRound,
  UsersRound,
  WalletCards,
} from "lucide-react";
import type { ReactNode } from "react";
import { Card, EmptyState, Hours, Metric, Money, PageHeader, Plain, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import type {
  PortalAgencySummary,
  PortalAgencyEmployeeSummary,
  PortalAgencyIndividualSummary,
  PortalDollarUsageSummary,
  PortalEmployeeSummary,
  PortalHomeReadModel,
  PortalIndividualSummary,
  PortalUsageSummary,
} from "@/lib/data/portal-read-model";
import type { PortalIndividualStatement } from "@/lib/data/portal-individual-statement";

function includes(agency: PortalAgencySummary, capability: PortalAgencySummary["capabilities"][number]) {
  return agency.capabilities.includes(capability);
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`));
}

function SummaryGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 border-b border-[var(--color-rule)] sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-r border-t border-[var(--color-rule)] px-4 py-3 first:border-t-0 sm:[&:nth-child(-n+3)]:border-t-0">
          <dt className="text-xs text-[var(--color-ink-faint)]">{item.label}</dt>
          <dd className="tnum mt-1 min-w-0 [overflow-wrap:anywhere] text-base font-semibold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BudgetSummary({
  hours,
  dollars,
}: {
  hours: PortalUsageSummary | null;
  dollars: PortalDollarUsageSummary | null;
}) {
  return (
    <>
      {hours ? <SummaryGrid items={[
        { label: "Hours authorized", value: <Hours value={hours.authorized} /> },
        { label: "Hours used", value: <Hours value={hours.used} /> },
        { label: "Hours remaining", value: <Hours value={hours.remaining} /> },
      ]} /> : null}
      {dollars ? <SummaryGrid items={[
        { label: "Dollars authorized", value: <Money value={dollars.authorized} /> },
        { label: "Dollars used", value: <Money value={dollars.used} /> },
        { label: "Dollars remaining", value: <Money value={dollars.remaining} /> },
      ]} /> : null}
    </>
  );
}

function ProgramBreakdown({
  programs,
  month,
}: {
  programs: PortalIndividualSummary["programs"];
  month: string;
}) {
  if (programs === null) return null;
  const selectedMonth = monthLabel(month);
  if (programs.length === 0) {
    return (
      <div className="border-t border-[var(--color-rule)]">
        <EmptyState compact title="No program budget or activity in this view" icon={<Clock3 aria-hidden className="h-5 w-5" />} />
      </div>
    );
  }
  const hasHours = programs.some((program) => program.hours !== null);
  const hasDollars = programs.some((program) => program.dollars !== null);
  const hasBilled = programs.some((program) => program.billedThisMonth !== null);
  const hasDirectChecks = programs.some((program) => program.directChecksThisMonth !== null);
  const hasAgencyPaid = programs.some((program) => program.agencyPaidThisMonth !== null);
  const hasCurrentBudget = hasHours || hasDollars;
  const hasMonthlyActivity = hasBilled || hasDirectChecks || hasAgencyPaid;
  const heading = hasCurrentBudget && hasMonthlyActivity
    ? `Current program budget and ${selectedMonth} activity`
    : hasCurrentBudget
      ? "Current program budget"
      : `Program activity for ${selectedMonth}`;

  return (
    <div className="border-t border-[var(--color-rule)]">
      <p className="border-b border-[var(--color-rule)] px-5 py-2.5 text-xs font-medium text-[var(--color-ink-soft)]">
        {heading}
      </p>
      <Table head={<>
        <Th>Program</Th>
        {hasHours ? <><Th numeric>Hours authorized</Th><Th numeric>Hours used</Th><Th numeric>Hours left</Th></> : null}
        {hasDollars ? <Th numeric>Dollar balance</Th> : null}
        {hasBilled ? <Th numeric>Billed ({selectedMonth})</Th> : null}
        {hasDirectChecks ? <Th numeric>Direct ({selectedMonth})</Th> : null}
        {hasAgencyPaid ? <Th numeric>Agency-paid ({selectedMonth})</Th> : null}
      </>}>
        {programs.map((program) => (
          <Tr key={program.id ?? `${program.code ?? "program"}:${program.name}`}>
            <Td>
              <div className="font-medium">{program.name}</div>
              {program.code ? <div className="text-xs text-[var(--color-ink-faint)]">{program.code}</div> : null}
            </Td>
            {hasHours ? <>
              <Td numeric>{program.hours ? <Hours value={program.hours.authorized} /> : <Plain value={null} />}</Td>
              <Td numeric>{program.hours ? <Hours value={program.hours.used} /> : <Plain value={null} />}</Td>
              <Td numeric>{program.hours ? <Hours value={program.hours.remaining} /> : <Plain value={null} />}</Td>
            </> : null}
            {hasDollars ? <Td numeric>{program.dollars ? <Money value={program.dollars.remaining} /> : <Plain value={null} />}</Td> : null}
            {hasBilled ? <Td numeric>{program.billedThisMonth !== null ? <Money value={program.billedThisMonth} /> : <Plain value={null} />}</Td> : null}
            {hasDirectChecks ? <Td numeric>{program.directChecksThisMonth !== null ? <Money value={program.directChecksThisMonth} /> : <Plain value={null} />}</Td> : null}
            {hasAgencyPaid ? <Td numeric>{program.agencyPaidThisMonth !== null ? <Money value={program.agencyPaidThisMonth} /> : <Plain value={null} />}</Td> : null}
          </Tr>
        ))}
      </Table>
    </div>
  );
}

function agencyIndividualResponsibility(individual: PortalAgencyIndividualSummary): string | null {
  if (individual.managesBudget === null && individual.billsServices === null) return null;
  if (individual.managesBudget && individual.billsServices) return "Budget + billing";
  if (individual.managesBudget) return "Budget managed";
  if (individual.billsServices) return "Billing only";
  return null;
}

function AgencyIndividualMember({ individual }: { individual: PortalAgencyIndividualSummary }) {
  const selectedMonth = monthLabel(individual.month);
  const responsibility = agencyIndividualResponsibility(individual);
  return (
    <details className="border-b border-[var(--color-rule)] last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 text-sm font-semibold hover:bg-[var(--color-surface-muted)]">
        <UserRound aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-primary)]" />
        <span className="min-w-0 flex-1 truncate">{individual.name}</span>
        {responsibility ? <StatusBadge tone={individual.managesBudget ? "good" : "muted"} label={responsibility} /> : null}
        <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
      </summary>
      <div className="border-t border-[var(--color-rule)] bg-[var(--color-surface-muted)]/40">
        <BudgetSummary hours={individual.hours} dollars={individual.dollars} />
        <SummaryGrid items={[
          individual.billedThisMonth !== null
            ? { label: `Billed (${selectedMonth})`, value: <Money value={individual.billedThisMonth} /> }
            : null,
          individual.setAsideThisMonth !== null
            ? { label: `Set aside (${selectedMonth})`, value: <Money value={individual.setAsideThisMonth} /> }
            : null,
          individual.directChecksThisMonth !== null
            ? { label: `Direct checks (${selectedMonth})`, value: <Money value={individual.directChecksThisMonth} /> }
            : null,
          individual.agencyPaidThisMonth !== null
            ? { label: `Agency-paid (${selectedMonth})`, value: <Money value={individual.agencyPaidThisMonth} /> }
            : null,
        ].filter(present)} />
        <ProgramBreakdown programs={individual.programs} month={individual.month} />
      </div>
    </details>
  );
}

function AgencyEmployeeMember({
  employee,
  canReadChecks,
}: {
  employee: PortalAgencyEmployeeSummary;
  canReadChecks: boolean;
}) {
  const selectedMonth = monthLabel(employee.month);
  const hasFinancialDetail = canReadChecks || employee.giveBack !== null;
  const summary = (
    <>
      <ReceiptText aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-primary)]" />
      <span className="min-w-0 flex-1 truncate">{employee.name}</span>
      {hasFinancialDetail ? <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" /> : null}
    </>
  );

  if (!hasFinancialDetail) {
    return <div className="flex items-center gap-3 border-b border-[var(--color-rule)] px-5 py-3 text-sm font-semibold last:border-b-0">{summary}</div>;
  }

  return (
    <details className="border-b border-[var(--color-rule)] last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 text-sm font-semibold hover:bg-[var(--color-surface-muted)]">
        {summary}
      </summary>
      <div className="border-t border-[var(--color-rule)] bg-[var(--color-surface-muted)]/40">
        <SummaryGrid items={[
          canReadChecks
            ? {
                label: `Check gross (${selectedMonth})`,
                value: employee.payrollGrossThisMonth === null
                  ? <Plain value="Unknown" />
                  : <Money value={employee.payrollGrossThisMonth} />,
              }
            : null,
          canReadChecks
            ? { label: `Check net (${selectedMonth})`, value: <Money value={employee.payrollNetThisMonth} /> }
            : null,
          employee.giveBack !== null
            ? { label: `Give-back due (${selectedMonth})`, value: <Money value={employee.giveBack.dueThisMonth} /> }
            : null,
          employee.giveBack !== null
            ? { label: `Collected (${selectedMonth})`, value: <Money value={employee.giveBack.collectedThisMonth} /> }
            : null,
          employee.giveBack !== null
            ? { label: "Give-back remaining", value: <Money value={employee.giveBack.remaining} /> }
            : null,
        ].filter(present)} />
        {canReadChecks && employee.checks !== null ? employee.checks.length === 0 ? (
          <EmptyState compact title={`No verified direct-pay checks for ${selectedMonth}`} icon={<ReceiptText aria-hidden className="h-5 w-5" />} />
        ) : (
          <Table head={<><Th>Check</Th><Th>Service date</Th><Th numeric>Gross</Th><Th numeric>Net</Th></>}>
            {employee.checks.map((check) => (
              <Tr key={check.id}>
                <Td><Plain value={check.checkNumber} /></Td>
                <Td><Plain value={check.serviceDate} /></Td>
                <Td numeric>{check.actualGross === null ? <Plain value="Unknown" /> : <Money value={check.actualGross} />}</Td>
                <Td numeric><Money value={check.actualNet} /></Td>
              </Tr>
            ))}
          </Table>
        ) : null}
      </div>
    </details>
  );
}

function AgencyMembers({ agency }: { agency: PortalAgencySummary }) {
  if (agency.individuals === null && agency.employees === null) return null;
  const canReadChecks = includes(agency, "financials.agency.direct_checks.read");
  return (
    <div className="border-t border-[var(--color-rule)]">
      {agency.individuals !== null ? (
        <details>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-semibold hover:bg-[var(--color-surface-muted)]">
            <UserRound aria-hidden className="h-4 w-4 text-[var(--color-primary)]" />
            Individuals
            <span className="tnum text-xs font-normal text-[var(--color-ink-faint)]">{agency.individuals.length}</span>
            <ChevronDown aria-hidden className="ml-auto h-4 w-4 text-[var(--color-ink-faint)]" />
          </summary>
          <div className="border-t border-[var(--color-rule)]">
            {agency.individuals.length === 0 ? (
              <EmptyState compact title="No individuals for this view" icon={<UserRound aria-hidden className="h-5 w-5" />} />
            ) : agency.individuals.map((individual) => (
              <AgencyIndividualMember key={individual.id} individual={individual} />
            ))}
          </div>
        </details>
      ) : null}
      {agency.employees !== null ? (
        <details className="border-t border-[var(--color-rule)]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-semibold hover:bg-[var(--color-surface-muted)]">
            <UsersRound aria-hidden className="h-4 w-4 text-[var(--color-primary)]" />
            Employees
            <span className="tnum text-xs font-normal text-[var(--color-ink-faint)]">{agency.employees.length}</span>
            <ChevronDown aria-hidden className="ml-auto h-4 w-4 text-[var(--color-ink-faint)]" />
          </summary>
          <div className="border-t border-[var(--color-rule)]">
            {agency.employees.length === 0 ? (
              <EmptyState compact title="No employees for this view" icon={<UsersRound aria-hidden className="h-5 w-5" />} />
            ) : agency.employees.map((employee) => (
              <AgencyEmployeeMember key={employee.id} employee={employee} canReadChecks={canReadChecks} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function AgencyAccess({ agency }: { agency: PortalAgencySummary }) {
  const selectedMonth = monthLabel(agency.month);
  const accessLabels = [
    includes(agency, "hours_budgets.agency.read") ? { label: "Authorized hours", icon: Clock3 } : null,
    includes(agency, "settlements.agency.read") ? { label: "Collection totals", icon: WalletCards } : null,
    includes(agency, "financials.agency.billed_totals.read") ? { label: "Agency financials", icon: Landmark } : null,
  ].filter((item): item is { label: string; icon: typeof CalendarDays } => item !== null);

  return (
    <Card className="h-full">
      <div className="border-b border-[var(--color-rule)] px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">{agency.code}</p>
            <h2 className="display mt-1 truncate text-base font-semibold">{agency.name}</h2>
          </div>
          <Building2 aria-hidden className="h-5 w-5 shrink-0 text-[var(--color-primary)]" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {agency.roles.map((role) => <StatusBadge key={role.key} tone="info" label={role.label} />)}
        </div>
      </div>

      {agency.individualCount !== null || agency.employeeCount !== null ? (
        <dl className="grid grid-cols-2 divide-x divide-[var(--color-rule)] border-b border-[var(--color-rule)]">
          <div className="px-5 py-3.5">
            <dt className="text-xs text-[var(--color-ink-faint)]">Individuals</dt>
            <dd className="tnum mt-1 text-lg font-semibold">{agency.individualCount ?? "-"}</dd>
          </div>
          <div className="px-5 py-3.5">
            <dt className="text-xs text-[var(--color-ink-faint)]">Employees</dt>
            <dd className="tnum mt-1 text-lg font-semibold">{agency.employeeCount ?? "-"}</dd>
          </div>
        </dl>
      ) : null}

      {agency.managedBudgetCount !== null ? (
        <dl className="grid grid-cols-2 divide-x divide-[var(--color-rule)] border-b border-[var(--color-rule)]">
          <div className="px-5 py-3.5">
            <dt className="text-xs text-[var(--color-ink-faint)]">Budgets managed</dt>
            <dd className="tnum mt-1 text-lg font-semibold">{agency.managedBudgetCount}</dd>
          </div>
          <div className="px-5 py-3.5">
            <dt className="text-xs text-[var(--color-ink-faint)]">Billing only</dt>
            <dd className="tnum mt-1 text-lg font-semibold">{agency.billingWithoutBudgetCount ?? 0}</dd>
          </div>
        </dl>
      ) : null}

      <BudgetSummary hours={agency.budgetHours} dollars={agency.budgetDollars} />

      <SummaryGrid items={[
        agency.billedThisMonth !== null ? { label: `Billed (${selectedMonth})`, value: <Money value={agency.billedThisMonth} /> } : null,
        agency.setAsideThisMonth !== null ? { label: `Set aside (${selectedMonth})`, value: <Money value={agency.setAsideThisMonth} /> } : null,
        agency.agencyPaidThisMonth !== null ? { label: `Agency-paid (${selectedMonth})`, value: <Money value={agency.agencyPaidThisMonth} /> } : null,
        includes(agency, "financials.agency.direct_checks.read") ? {
          label: `Check gross (${selectedMonth})`,
          value: agency.payrollGrossThisMonth === null
            ? <Plain value="Unknown" />
            : <Money value={agency.payrollGrossThisMonth} />,
        } : null,
        agency.payrollNetThisMonth !== null ? { label: `Check net (${selectedMonth})`, value: <Money value={agency.payrollNetThisMonth} /> } : null,
        agency.giveBackRemaining !== null ? { label: "Give-back remaining", value: <Money value={agency.giveBackRemaining} /> } : null,
      ].filter(present)} />

      {accessLabels.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-2 px-5 py-4">
          {accessLabels.map(({ label, icon: Icon }) => (
            <span key={label} className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-ink-soft)]">
              <Icon aria-hidden className="h-3.5 w-3.5 text-[var(--color-primary)]" />
              {label}
            </span>
          ))}
        </div>
      ) : null}

      <AgencyMembers agency={agency} />
    </Card>
  );
}

function statementHref(
  statement: PortalIndividualStatement,
  scope: "month" | "trend",
  format: "csv" | "html",
): string {
  const params = new URLSearchParams({
    individualId: statement.individualId,
    month: statement.throughMonth,
    scope,
    format,
  });
  return `/api/portal/individual-statements?${params.toString()}`;
}

function IndividualTrend({ statement }: { statement: PortalIndividualStatement }) {
  const visible = statement.visibility;
  if (!Object.values(visible).some(Boolean)) return null;
  return (
    <div className="border-t border-[var(--color-rule)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule)] px-5 py-3">
        <div>
          <p className="text-sm font-semibold">{statement.months.length}-month history</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Monthly totals through {monthLabel(statement.throughMonth)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={statementHref(statement, "month", "html")}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"
          >
            <Printer aria-hidden className="h-3.5 w-3.5" />
            Print month
          </Link>
          <Link
            href={statementHref(statement, "trend", "html")}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"
          >
            <Printer aria-hidden className="h-3.5 w-3.5" />
            Print history
          </Link>
          <Link
            href={statementHref(statement, "trend", "csv")}
            className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"
          >
            <Download aria-hidden className="h-3.5 w-3.5" />
            Download
          </Link>
        </div>
      </div>
      <Table head={<>
        <Th>Month</Th>
        {visible.billed ? <Th numeric>Billed</Th> : null}
        {visible.setAside ? <Th numeric>Set aside</Th> : null}
        {visible.direct ? <Th numeric>Direct-paid</Th> : null}
        {visible.agencyPaid ? <Th numeric>Agency-paid</Th> : null}
      </>}>
        {[...statement.months].reverse().map((row) => (
          <Tr key={row.month}>
            <Td>{monthLabel(row.month)}</Td>
            {visible.billed ? <Td numeric><Money value={row.billed} /></Td> : null}
            {visible.setAside ? <Td numeric><Money value={row.setAside} /></Td> : null}
            {visible.direct ? <Td numeric><Money value={row.direct} /></Td> : null}
            {visible.agencyPaid ? <Td numeric><Money value={row.agencyPaid} /></Td> : null}
          </Tr>
        ))}
      </Table>
    </div>
  );
}

function IndividualAccess({
  individual,
  statement,
}: {
  individual: PortalIndividualSummary;
  statement?: PortalIndividualStatement;
}) {
  const selectedMonth = monthLabel(individual.month);
  return (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-rule)] px-5 py-4">
        <div className="min-w-0">
          <p className="eyebrow">{individual.relationships.join(" · ")}</p>
          <h3 className="display mt-1 truncate text-base font-semibold">{individual.name}</h3>
        </div>
        <UserRound aria-hidden className="h-5 w-5 shrink-0 text-[var(--color-primary)]" />
      </div>
      <BudgetSummary hours={individual.hours} dollars={individual.dollars} />
      <SummaryGrid items={[
        individual.billedThisMonth !== null ? { label: `Billed (${selectedMonth})`, value: <Money value={individual.billedThisMonth} /> } : null,
        individual.setAsideThisMonth !== null ? { label: `Set aside (${selectedMonth})`, value: <Money value={individual.setAsideThisMonth} /> } : null,
        individual.directChecksThisMonth !== null ? { label: `Direct checks (${selectedMonth})`, value: <Money value={individual.directChecksThisMonth} /> } : null,
        individual.agencyPaidThisMonth !== null ? { label: `Agency-paid (${selectedMonth})`, value: <Money value={individual.agencyPaidThisMonth} /> } : null,
      ].filter(present)} />
      <ProgramBreakdown programs={individual.programs} month={individual.month} />
      {statement ? <IndividualTrend statement={statement} /> : null}
    </Card>
  );
}

function EmployeeAccess({ employee }: { employee: PortalEmployeeSummary }) {
  const selectedMonth = monthLabel(employee.month);
  return (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-rule)] px-5 py-4">
        <div className="min-w-0">
          <p className="eyebrow">Employee</p>
          <h3 className="display mt-1 truncate text-base font-semibold">{employee.name}</h3>
        </div>
        <ReceiptText aria-hidden className="h-5 w-5 shrink-0 text-[var(--color-primary)]" />
      </div>
      {employee.giveBack ? <SummaryGrid items={[
        { label: `Give-back due (${selectedMonth})`, value: <Money value={employee.giveBack.dueThisMonth} /> },
        { label: `Collected (${selectedMonth})`, value: <Money value={employee.giveBack.collectedThisMonth} /> },
        { label: "Give-back remaining", value: <Money value={employee.giveBack.remaining} /> },
      ]} /> : null}
      {employee.directPay !== null ? employee.directPay.length === 0 ? (
        <EmptyState compact title={`No direct-pay services linked to verified checks for ${selectedMonth}`} icon={<ReceiptText aria-hidden className="h-5 w-5" />} />
      ) : (
        <div>
          <p className="border-b border-[var(--color-rule)] px-5 py-2.5 text-xs font-medium text-[var(--color-ink-soft)]">
            Direct-pay services linked to verified checks for {selectedMonth}
          </p>
          <Table head={<>
            <Th>Service date</Th><Th>Check</Th><Th>Individual</Th><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Gross service value</Th>
          </>}>
            {employee.directPay.map((item) => (
              <Tr key={item.id}>
                <Td><Plain value={item.serviceDate} /></Td>
                <Td><Plain value={item.checkNumber} /></Td>
                <Td>{item.individualName}</Td>
                <Td>
                  <div className="font-medium">{item.programName}</div>
                  {item.programCode ? <div className="text-xs text-[var(--color-ink-faint)]">{item.programCode}</div> : null}
                </Td>
                <Td numeric><Hours value={item.hours} /></Td>
                <Td numeric><Money value={item.grossServiceValue} /></Td>
              </Tr>
            ))}
          </Table>
        </div>
      ) : null}
      {employee.checks !== null ? employee.checks.length === 0 ? (
        <EmptyState compact title={`No verified payroll checks for ${selectedMonth}`} icon={<ReceiptText aria-hidden className="h-5 w-5" />} />
      ) : (
        <div>
          <p className="border-b border-[var(--color-rule)] px-5 py-2.5 text-xs font-medium text-[var(--color-ink-soft)]">
            Verified checks for {selectedMonth}
          </p>
          <Table head={<>
            <Th>Check</Th><Th>Service date</Th>
            {employee.checkVisibility.gross ? <Th numeric>Gross</Th> : null}
            {employee.checkVisibility.net ? <Th numeric>Net</Th> : null}
            {employee.checkVisibility.tax ? <Th numeric>Tax withheld</Th> : null}
          </>}>
            {employee.checks.map((check) => (
              <Tr key={check.id}>
                <Td><Plain value={check.checkNumber} /></Td>
                <Td><Plain value={check.serviceDate} /></Td>
                {employee.checkVisibility.gross ? (
                  <Td numeric>{check.actualGross === null ? <Plain value="Unknown" /> : <Money value={check.actualGross} />}</Td>
                ) : null}
                {employee.checkVisibility.net ? <Td numeric><Money value={check.actualNet} /></Td> : null}
                {employee.checkVisibility.tax ? <Td numeric><Money value={check.taxWithheld} /></Td> : null}
              </Tr>
            ))}
          </Table>
        </div>
      ) : null}
    </Card>
  );
}

export default function PortalHome({
  displayName,
  model,
  individualStatements = [],
}: {
  displayName: string;
  model: PortalHomeReadModel;
  individualStatements?: PortalIndividualStatement[];
}) {
  const owner = model.globalRoles.some((role) => role.key === "owner");
  const hasPortalIdentity = model.globalRoles.length > 0 || model.agencies.length > 0;

  return (
    <>
      <PageHeader
        eyebrow="My portal"
        title={`Welcome, ${displayName}`}
        description="Your profiles, organizations, and current access in one place."
        action={owner ? (
          <Link href="/settings/agencies" className="btn btn-secondary btn-sm">
            <Settings2 aria-hidden className="h-4 w-4" />
            Manage agencies
          </Link>
        ) : undefined}
      />

      <form action="/portal" method="get" className="mb-6 flex flex-wrap items-end justify-between gap-3 border-y border-[var(--color-rule)] py-3">
        <label className="block">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <CalendarDays aria-hidden className="h-4 w-4 text-[var(--color-primary)]" />
            Reporting month
          </span>
          <input
            type="month"
            name="month"
            defaultValue={model.month}
            className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
          />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm">View month</button>
      </form>

      {!hasPortalIdentity ? (
        <Card>
          <EmptyState title="Portal access is not assigned" icon={<ShieldCheck aria-hidden className="h-5 w-5" />}>
            Your account is active, but it is not linked to a portal profile or agency.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="portal-summary-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="portal-summary-heading" className="display text-base font-semibold">Your access</h2>
              <div className="flex flex-wrap gap-1.5">
                {model.globalRoles.map((role) => <StatusBadge key={role.key} tone="good" label={role.label} />)}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric
                label="Individual profiles"
                value={model.directProfiles.individualCount}
                icon={<UserRound aria-hidden className="h-4 w-4" />}
              />
              <Metric
                label="Employee profiles"
                value={model.directProfiles.employeeCount}
                icon={<UsersRound aria-hidden className="h-4 w-4" />}
              />
              <Metric
                label="Organizations"
                value={model.agencies.length}
                icon={<Building2 aria-hidden className="h-4 w-4" />}
              />
            </div>
          </section>

          {model.individuals.length > 0 ? (
            <section aria-labelledby="portal-individuals-heading">
              <div className="mb-3 flex items-center gap-2">
                <BadgeDollarSign aria-hidden className="h-4 w-4 text-[var(--color-primary)]" />
                <h2 id="portal-individuals-heading" className="display text-base font-semibold">Individual budgets</h2>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {model.individuals.map((individual) => (
                  <IndividualAccess
                    key={individual.id}
                    individual={individual}
                    statement={individualStatements.find((item) => item.individualId === individual.id)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {model.employees.length > 0 ? (
            <section aria-labelledby="portal-employees-heading">
              <h2 id="portal-employees-heading" className="display mb-3 text-base font-semibold">Employee payroll</h2>
              <div className="grid gap-4 xl:grid-cols-2">
                {model.employees.map((employee) => <EmployeeAccess key={employee.id} employee={employee} />)}
              </div>
            </section>
          ) : null}

          {model.agencies.length > 0 ? (
            <section aria-labelledby="portal-agencies-heading">
              <h2 id="portal-agencies-heading" className="display mb-3 text-base font-semibold">Organizations</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {model.agencies.map((agency) => <AgencyAccess key={agency.id} agency={agency} />)}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}

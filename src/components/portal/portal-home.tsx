import Link from "next/link";
import {
  BadgeDollarSign,
  Building2,
  CalendarDays,
  Clock3,
  Landmark,
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
  PortalDollarUsageSummary,
  PortalEmployeeSummary,
  PortalHomeReadModel,
  PortalIndividualSummary,
  PortalUsageSummary,
} from "@/lib/data/portal-read-model";

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
        agency.payrollGrossThisMonth !== null ? { label: `Check gross (${selectedMonth})`, value: <Money value={agency.payrollGrossThisMonth} /> } : null,
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
    </Card>
  );
}

function IndividualAccess({ individual }: { individual: PortalIndividualSummary }) {
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
    </Card>
  );
}

function EmployeeAccess({ employee }: { employee: PortalEmployeeSummary }) {
  const selectedMonth = employee.giveBack ? monthLabel(employee.giveBack.month) : null;
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
      {employee.checks !== null ? employee.checks.length === 0 ? (
        <EmptyState compact title="No verified payroll checks" icon={<ReceiptText aria-hidden className="h-5 w-5" />} />
      ) : (
        <Table head={<>
          <Th>Check</Th><Th>Date</Th>
          {employee.checkVisibility.gross ? <Th numeric>Gross</Th> : null}
          {employee.checkVisibility.net ? <Th numeric>Net</Th> : null}
          {employee.checkVisibility.tax ? <Th numeric>Tax withheld</Th> : null}
        </>}>
          {employee.checks.map((check) => (
            <Tr key={check.id}>
              <Td><Plain value={check.checkNumber} /></Td>
              <Td><Plain value={check.checkDate ?? check.periodEnd} /></Td>
              {employee.checkVisibility.gross ? <Td numeric><Money value={check.actualGross} /></Td> : null}
              {employee.checkVisibility.net ? <Td numeric><Money value={check.actualNet} /></Td> : null}
              {employee.checkVisibility.tax ? <Td numeric><Money value={check.taxWithheld} /></Td> : null}
            </Tr>
          ))}
        </Table>
      ) : null}
    </Card>
  );
}

export default function PortalHome({
  displayName,
  model,
}: {
  displayName: string;
  model: PortalHomeReadModel;
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
                {model.individuals.map((individual) => <IndividualAccess key={individual.id} individual={individual} />)}
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

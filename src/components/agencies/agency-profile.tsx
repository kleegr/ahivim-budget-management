import Link from "next/link";
import { CalendarDays, UserRound, UsersRound } from "lucide-react";
import { EmptyState, Hours, Money, Plain, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import type { PortalAgencySummary } from "@/lib/data/portal-read-model";

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function compactLink(href: string, label: string) {
  return <Link href={href} className="touch-target inline-flex items-center text-xs font-semibold text-[var(--color-primary)] hover:underline">{label}</Link>;
}

function SummaryBand({ agency }: { agency: PortalAgencySummary }) {
  const items = [
    { label: "Individuals", value: <Plain value={agency.individualCount} /> },
    { label: "Employees", value: <Plain value={agency.employeeCount} /> },
    { label: "Budgets managed", value: <Plain value={agency.managedBudgetCount} /> },
    { label: "Hours authorized", value: agency.budgetHours ? <Hours value={agency.budgetHours.authorized} /> : <Plain value={null} /> },
    { label: "Hours used", value: agency.budgetHours ? <Hours value={agency.budgetHours.used} /> : <Plain value={null} /> },
    { label: "Hours remaining", value: agency.budgetHours ? <Hours value={agency.budgetHours.remaining} /> : <Plain value={null} /> },
  ];
  return (
    <dl className="grid border-y border-[var(--color-rule)] sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="border-b border-r border-[var(--color-rule)] px-4 py-3 lg:[&:nth-last-child(-n+3)]:border-b-0">
          <dt className="text-xs text-[var(--color-ink-faint)]">{item.label}</dt>
          <dd className="tnum mt-1 text-base font-semibold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function responsibility(managesBudget: boolean | null, billsServices: boolean | null): string {
  if (managesBudget && billsServices) return "Budget + billing";
  if (managesBudget) return "Budget managed";
  if (billsServices) return "Billing only";
  return "Roster only";
}

export default function AgencyProfile({ agency }: { agency: PortalAgencySummary }) {
  const selectedMonth = monthLabel(agency.month);
  const individuals = agency.individuals ?? [];
  const employees = agency.employees ?? [];
  const showIndividualHours = individuals.some((individual) => individual.hours !== null);
  const showIndividualDollars = individuals.some((individual) => individual.dollars !== null);
  const showIndividualBilled = individuals.some((individual) => individual.billedThisMonth !== null);
  const showEmployeeChecks = employees.some((employee) => employee.payrollNetThisMonth !== null);
  const showGiveBack = employees.some((employee) => employee.giveBack !== null);

  return (
    <div className="space-y-7">
      <form action={`/agencies/${agency.id}`} method="get" className="flex flex-wrap items-end justify-between gap-3 border-y border-[var(--color-rule)] py-3">
        <label>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <CalendarDays aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Reporting month
          </span>
          <input type="month" name="month" defaultValue={agency.month} className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm">View month</button>
      </form>

      <SummaryBand agency={agency} />

      <section aria-labelledby="agency-financial-summary" className="border-y border-[var(--color-rule)]">
        <div className="border-b border-[var(--color-rule)] px-4 py-3">
          <h2 id="agency-financial-summary" className="display text-base font-semibold">Actual financial activity</h2>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Recorded values for {selectedMonth}, except the current outstanding give-back balance. These are not projected budget amounts.</p>
        </div>
        <dl className="grid sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: "Funder billed", value: agency.billedThisMonth },
            { label: "Individual set-aside", value: agency.setAsideThisMonth },
            { label: "Agency-paid employee base", value: agency.agencyPaidThisMonth },
            { label: "Verified direct-check net", value: agency.payrollNetThisMonth },
            { label: "Current give-back remaining", value: agency.giveBackRemaining },
          ].map((item) => (
            <div key={item.label} className="border-b border-[var(--color-rule)] px-4 py-3 last:border-b-0 sm:border-r lg:border-b-0 lg:last:border-r-0">
              <dt className="text-xs text-[var(--color-ink-faint)]">{item.label}</dt>
              <dd className="tnum mt-1 text-base font-semibold"><Money value={item.value} /></dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="agency-individuals-heading" className="border-y border-[var(--color-rule)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-rule)] px-4 py-3">
          <div>
            <h2 id="agency-individuals-heading" className="display flex items-center gap-2 text-base font-semibold"><UserRound aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Individuals</h2>
            <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Budget responsibility and actual service-month activity.</p>
          </div>
          <span className="tnum text-xs text-[var(--color-ink-faint)]">{individuals.length}</span>
        </div>
        {individuals.length === 0 ? (
          <EmptyState compact title="No current individuals on this roster" icon={<UserRound aria-hidden className="h-5 w-5" />} />
        ) : (
          <Table caption={`${agency.name} individual roster`} head={<>
            <Th>Individual</Th><Th>Responsibility</Th>
            {showIndividualHours ? <><Th numeric>Used hours</Th><Th numeric>Hours left</Th></> : null}
            {showIndividualDollars ? <Th numeric>Dollar balance</Th> : null}
            {showIndividualBilled ? <Th numeric>Billed ({selectedMonth})</Th> : null}
            <Th>Open</Th>
          </>}>
            {individuals.map((individual) => (
              <Tr key={individual.id}>
                <Td><Link href={`/individuals/${individual.id}`} className="font-semibold text-[var(--color-primary)] hover:underline">{individual.name}</Link></Td>
                <Td><StatusBadge tone={individual.managesBudget ? "good" : individual.billsServices ? "warn" : "muted"} label={responsibility(individual.managesBudget, individual.billsServices)} /></Td>
                {showIndividualHours ? <>
                  <Td numeric>{individual.hours ? <Hours value={individual.hours.used} /> : <Plain value={null} />}</Td>
                  <Td numeric>{individual.hours ? <Hours value={individual.hours.remaining} /> : <Plain value={null} />}</Td>
                </> : null}
                {showIndividualDollars ? <Td numeric>{individual.dollars ? <Money value={individual.dollars.remaining} /> : <Plain value={null} />}</Td> : null}
                {showIndividualBilled ? <Td numeric><Money value={individual.billedThisMonth} /></Td> : null}
                <Td>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {compactLink(`/individuals/${individual.id}`, "Profile")}
                    {compactLink(`/schedule?view=calendar&individualId=${individual.id}`, "Schedule")}
                  </div>
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </section>

      <section aria-labelledby="agency-employees-heading" className="border-y border-[var(--color-rule)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-rule)] px-4 py-3">
          <div>
            <h2 id="agency-employees-heading" className="display flex items-center gap-2 text-base font-semibold"><UsersRound aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Employees</h2>
            <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Current staffing roster with permitted check and collection summaries.</p>
          </div>
          <span className="tnum text-xs text-[var(--color-ink-faint)]">{employees.length}</span>
        </div>
        {employees.length === 0 ? (
          <EmptyState compact title="No current employees on this roster" icon={<UsersRound aria-hidden className="h-5 w-5" />} />
        ) : (
          <Table caption={`${agency.name} employee roster`} head={<>
            <Th>Employee</Th>
            {showEmployeeChecks ? <><Th numeric>Verified check gross</Th><Th numeric>Verified check net</Th></> : null}
            {showGiveBack ? <Th numeric>Current give-back remaining</Th> : null}
            <Th>Open</Th>
          </>}>
            {employees.map((employee) => (
              <Tr key={employee.id}>
                <Td><Link href={`/employees/${employee.id}`} className="font-semibold text-[var(--color-primary)] hover:underline">{employee.name}</Link></Td>
                {showEmployeeChecks ? <>
                  <Td numeric><Money value={employee.payrollGrossThisMonth} /></Td>
                  <Td numeric><Money value={employee.payrollNetThisMonth} /></Td>
                </> : null}
                {showGiveBack ? <Td numeric><Money value={employee.giveBack?.remaining ?? null} /></Td> : null}
                <Td>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {compactLink(`/employees/${employee.id}`, "Profile")}
                    {compactLink(`/schedule?view=calendar&employeeId=${employee.id}`, "Schedule")}
                  </div>
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}

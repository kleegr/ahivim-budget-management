import Link from "next/link";
import { ArrowRight, Building2, CalendarDays, Settings2 } from "lucide-react";
import { EmptyState, Hours, Money, Plain, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import type { AgencyDirectoryReadModel } from "@/lib/data/agency-directory";

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function SummaryBand({ directory }: { directory: AgencyDirectoryReadModel }) {
  const items = [
    { label: "Active agencies", value: directory.totals.agencies },
    { label: "Individual memberships", value: directory.totals.individuals },
    { label: "Employee memberships", value: directory.totals.employees },
    { label: "Managed-budget memberships", value: directory.totals.managedBudgets },
    { label: "Billing-only memberships", value: directory.totals.billingWithoutBudget },
  ];
  return (
    <dl className="mb-6 grid border-y border-[var(--color-rule)] sm:grid-cols-3 xl:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="border-b border-[var(--color-rule)] px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
          <dt className="text-xs text-[var(--color-ink-faint)]">{item.label}</dt>
          <dd className="tnum mt-1 text-lg font-semibold"><Plain value={item.value} /></dd>
        </div>
      ))}
    </dl>
  );
}

export default function AgencyDirectory({
  directory,
  query,
}: {
  directory: AgencyDirectoryReadModel;
  query: string;
}) {
  const normalized = query.trim().toLocaleLowerCase();
  const agencies = normalized
    ? directory.agencies.filter((agency) => `${agency.name} ${agency.code}`.toLocaleLowerCase().includes(normalized))
    : directory.agencies;
  const selectedMonth = monthLabel(directory.month);

  return (
    <>
      <form action="/agencies" method="get" className="mb-6 flex flex-wrap items-end gap-3 border-y border-[var(--color-rule)] py-3">
        <label className="min-w-56 flex-1">
          <span className="text-sm font-medium">Find an agency</span>
          <input className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" type="search" name="q" defaultValue={query} placeholder="Name or code" />
        </label>
        <label>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <CalendarDays aria-hidden className="h-4 w-4 text-[var(--color-primary)]" />
            Reporting month
          </span>
          <input className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" type="month" name="month" defaultValue={directory.month} />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm">Apply</button>
      </form>

      <SummaryBand directory={directory} />

      {agencies.length === 0 ? (
        <div className="border-y border-[var(--color-rule)]">
          <EmptyState title={directory.agencies.length === 0 ? "No active agencies" : "No agencies match this search"} icon={<Building2 aria-hidden className="h-5 w-5" />}>
            {directory.agencies.length === 0 ? (
              <Link href="/settings/agencies" className="btn btn-secondary btn-sm mt-3">
                <Settings2 aria-hidden className="h-4 w-4" /> Agency setup
              </Link>
            ) : <p>Try a different name or agency code.</p>}
          </EmptyState>
        </div>
      ) : (
        <section aria-labelledby="agency-directory-heading" className="border-y border-[var(--color-rule)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] px-4 py-3">
            <div>
              <h2 id="agency-directory-heading" className="display text-base font-semibold">Agency directory</h2>
              <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Current rosters, budget responsibility, and actual activity for {selectedMonth}.</p>
            </div>
            <span className="tnum text-xs text-[var(--color-ink-faint)]">{agencies.length} shown</span>
          </div>
          <Table caption="Agency operational directory" head={<>
            <Th>Agency</Th>
            <Th numeric>Individuals</Th>
            <Th numeric>Employees</Th>
            <Th numeric>Budgets managed</Th>
            <Th numeric>Hours left</Th>
            <Th numeric>Actual billed</Th>
            <Th><span className="sr-only">Open</span></Th>
          </>}>
            {agencies.map((agency) => (
              <Tr key={agency.id}>
                <Td>
                  <Link href={`/agencies/${agency.id}?month=${directory.month}`} className="font-semibold text-[var(--color-primary)] hover:underline">
                    {agency.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">
                    <span>{agency.code}</span>
                    {(agency.billingWithoutBudgetCount ?? 0) > 0 ? <StatusBadge tone="warn" label={`${agency.billingWithoutBudgetCount} billing only`} /> : null}
                  </div>
                </Td>
                <Td numeric>{agency.individualCount ?? <Plain value={null} />}</Td>
                <Td numeric>{agency.employeeCount ?? <Plain value={null} />}</Td>
                <Td numeric>{agency.managedBudgetCount ?? <Plain value={null} />}</Td>
                <Td numeric>{agency.budgetHours ? <Hours value={agency.budgetHours.remaining} /> : <Plain value={null} />}</Td>
                <Td numeric>{agency.billedThisMonth !== null ? <Money value={agency.billedThisMonth} /> : <Plain value={null} />}</Td>
                <Td>
                  <Link href={`/agencies/${agency.id}?month=${directory.month}`} className="touch-target inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-primary)] hover:underline">
                    Open <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                  </Link>
                </Td>
              </Tr>
            ))}
          </Table>
        </section>
      )}
    </>
  );
}

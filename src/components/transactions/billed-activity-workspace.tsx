"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FileCheck2, ListTree, Search, TableProperties } from "lucide-react";
import { dec, formatHours, formatMoney } from "@/lib/money";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { TransactionFieldVisibility } from "@/lib/auth/money-redaction";
import type { FilterState } from "@/components/data-grid/types";
import PeriodControl, { type PeriodRange } from "@/components/period-control";
import { Card, EmptyState, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import TransactionsGrid from "@/components/transactions/transactions-grid";

type WorkspaceView = "checks" | "rows";
type Routing = "direct" | "agency" | "review";

interface CheckSummary {
  key: string;
  checkNumber: string | null;
  checkDate: string | null;
  employee: string | null;
  employeeId: string | null;
  payTo: string | null;
  routing: Routing;
  periodBegin: string | null;
  periodEnd: string | null;
  individuals: string[];
  programs: string[];
  hours: string;
  funderBilled: string;
  employeeBase: string;
  agencySpread: string;
  netPay: string | null;
  rows: number;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

const dateLabel = (value: string | null): string => {
  if (!value) return "Date missing";
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00`));
};

const routingLabel = (routing: Routing) => {
  if (routing === "direct") return <StatusBadge tone="info" label="Direct to employee" />;
  if (routing === "agency") return <StatusBadge tone="good" label="Agency-routed" />;
  return <StatusBadge tone="warn" label="Routing review" />;
};

function groupChecks(rows: GridTransaction[]): CheckSummary[] {
  const groups = new Map<string, GridTransaction[]>();
  for (const row of rows) {
    const employeeKey = row.employeeId ?? row.employee ?? "unknown-employee";
    const key = row.checkNumber
      ? `${employeeKey}:check:${row.checkNumber}`
      : `${employeeKey}:row:${row.id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const first = group[0];
    let hours = dec(0);
    let funderBilled = dec(0);
    let employeeBase = dec(0);
    let agencySpread = dec(0);
    const individuals = new Set<string>();
    const programs = new Set<string>();
    const recipients = new Set(group.map((row) => row.paymentRecipient).filter(Boolean));
    const begins = group.map((row) => row.periodBegin).filter((value): value is string => Boolean(value)).sort();
    const ends = group.map((row) => row.periodEnd).filter((value): value is string => Boolean(value)).sort();

    for (const row of group) {
      if (row.hours) hours = hours.plus(row.hours);
      if (row.gross) funderBilled = funderBilled.plus(row.gross);
      if (row.internalAmount) employeeBase = employeeBase.plus(row.internalAmount);
      if (row.agencyAdditional) agencySpread = agencySpread.plus(row.agencyAdditional);
      if (row.individual) individuals.add(row.individual);
      if (row.program) programs.add(row.program);
    }

    const routing: Routing = recipients.size === 1 && recipients.has("employee")
      ? "direct"
      : recipients.size === 1 && recipients.has("excellent_staffing")
        ? "agency"
        : "review";

    return {
      key,
      checkNumber: first.checkNumber,
      checkDate: first.checkDate,
      employee: first.employee,
      employeeId: first.employeeId,
      payTo: first.payTo,
      routing,
      periodBegin: begins[0] ?? null,
      periodEnd: ends.at(-1) ?? null,
      individuals: [...individuals].sort(),
      programs: [...programs].sort(),
      hours: hours.toFixed(2),
      funderBilled: funderBilled.toFixed(2),
      employeeBase: employeeBase.toFixed(2),
      agencySpread: agencySpread.toFixed(2),
      netPay: routing === "direct" ? first.totalNetPay : null,
      rows: group.length,
    };
  }).sort((a, b) => (b.checkDate ?? "").localeCompare(a.checkDate ?? "") || (a.employee ?? "").localeCompare(b.employee ?? ""));
}

function ChecksView({ rows, visibility }: { rows: GridTransaction[]; visibility: TransactionFieldVisibility }) {
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<PeriodRange>(null);
  const checks = useMemo(() => groupChecks(rows), [rows]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return checks.filter((check) => {
      if (period && (!check.checkDate || check.checkDate < period.from || check.checkDate > period.to)) return false;
      if (!needle) return true;
      return [
        check.checkNumber,
        check.employee,
        check.payTo,
        ...check.individuals,
        ...check.programs,
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
    });
  }, [checks, period, query]);

  const totals = useMemo(() => filtered.reduce((result, check) => ({
    funderBilled: result.funderBilled.plus(check.funderBilled),
    employeeBase: result.employeeBase.plus(check.employeeBase),
    agencySpread: result.agencySpread.plus(check.agencySpread),
    directNet: result.directNet.plus(check.netPay ?? 0),
    hours: result.hours.plus(check.hours),
  }), {
    funderBilled: dec(0),
    employeeBase: dec(0),
    agencySpread: dec(0),
    directNet: dec(0),
    hours: dec(0),
  }), [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PeriodControl onChange={setPeriod} paramKey="period" />
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Search checks</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search checks"
            className="input w-full pl-9"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
        <SummaryMetric label="Checks" value={filtered.length.toLocaleString()} />
        {visibility.canSeeBilledAmounts ? <SummaryMetric label="Funder billed" value={formatMoney(totals.funderBilled)} /> : null}
        {visibility.canSeeEmployeeAmounts ? <SummaryMetric label="Employee base" value={formatMoney(totals.employeeBase)} /> : null}
        {visibility.canSeeAgencySpread ? <SummaryMetric label="Agency spread" value={formatMoney(totals.agencySpread)} /> : null}
        {visibility.canSeeCheckNet ? <SummaryMetric label="Direct-check net" value={formatMoney(totals.directNet)} /> : null}
        {visibility.canSeeHours ? <SummaryMetric label="Hours" value={formatHours(totals.hours)} /> : null}
      </div>

      <Card>
        {filtered.length === 0 ? (
          <EmptyState title="No checks match" compact />
        ) : (
          <Table
            caption="Checks and their billed activity"
            head={<>
              <Th>Check</Th>
              <Th>Employee</Th>
              <Th>Routing</Th>
              <Th>Pay period</Th>
              <Th>People served</Th>
              {visibility.canSeeHours ? <Th numeric>Hours</Th> : null}
              {visibility.canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}
              {visibility.canSeeEmployeeAmounts ? <Th numeric>Employee base</Th> : null}
              {visibility.canSeeAgencySpread ? <Th numeric>Agency spread</Th> : null}
              {visibility.canSeeCheckNet ? <Th numeric>Check net</Th> : null}
              <Th><span className="sr-only">Open</span></Th>
            </>}
          >
            {filtered.map((check) => (
              <Tr key={check.key}>
                <Td>
                  <div className="font-semibold text-[var(--color-ink)]">{check.checkNumber ? `#${check.checkNumber}` : "Number missing"}</div>
                  <div className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{dateLabel(check.checkDate)}</div>
                </Td>
                <Td>
                  {check.employeeId ? <Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/employees/${check.employeeId}`}>{check.employee ?? "Employee"}</Link> : (check.employee ?? "Employee missing")}
                  {check.payTo ? <div className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Pay to {check.payTo}</div> : null}
                </Td>
                <Td>{routingLabel(check.routing)}</Td>
                <Td>
                  {check.periodBegin || check.periodEnd
                    ? `${dateLabel(check.periodBegin)} to ${dateLabel(check.periodEnd)}`
                    : "Period missing"}
                </Td>
                <Td>
                  <span className="font-medium text-[var(--color-ink)]">{check.individuals.length.toLocaleString()}</span>
                  <div className="mt-0.5 max-w-52 truncate text-xs text-[var(--color-ink-faint)]" title={check.individuals.join(", ")}>{check.individuals.join(", ") || "Unmatched"}</div>
                </Td>
                {visibility.canSeeHours ? <Td numeric>{formatHours(check.hours)}</Td> : null}
                {visibility.canSeeBilledAmounts ? <Td numeric>{formatMoney(check.funderBilled)}</Td> : null}
                {visibility.canSeeEmployeeAmounts ? <Td numeric>{formatMoney(check.employeeBase)}</Td> : null}
                {visibility.canSeeAgencySpread ? <Td numeric>{formatMoney(check.agencySpread)}</Td> : null}
                {visibility.canSeeCheckNet ? <Td numeric>{check.netPay ? formatMoney(check.netPay) : <span className="text-[var(--color-ink-faint)]">-</span>}</Td> : null}
                <Td>
                  {check.checkNumber ? (
                    <Link href={`/transactions?checkNumber=${encodeURIComponent(check.checkNumber)}`} className="btn btn-sm btn-ghost whitespace-nowrap">
                      {check.rows.toLocaleString()} {check.rows === 1 ? "row" : "rows"}
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--color-ink-faint)]">{check.rows.toLocaleString()} row</span>
                  )}
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4">
      <div className="eyebrow truncate">{label}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-[var(--color-ink)]">{value}</div>
    </div>
  );
}

export default function BilledActivityWorkspace({
  rows,
  canManage,
  visibility,
  canSeeBudgets,
  initialFilters,
  contextLabel,
}: {
  rows: GridTransaction[];
  canManage: boolean;
  visibility: TransactionFieldVisibility;
  canSeeBudgets: boolean;
  initialFilters?: FilterState;
  contextLabel?: string | null;
}) {
  const [view, setView] = useState<WorkspaceView>(contextLabel ? "rows" : "checks");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="segmented-control" role="tablist" aria-label="Billed activity view">
          <button type="button" role="tab" aria-selected={view === "checks"} onClick={() => setView("checks")}>
            <FileCheck2 aria-hidden className="h-4 w-4" /> Checks
          </button>
          <button type="button" role="tab" aria-selected={view === "rows"} onClick={() => setView("rows")}>
            <TableProperties aria-hidden className="h-4 w-4" /> Transaction rows
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--color-ink-faint)]">
          <ListTree aria-hidden className="h-4 w-4" />
          {rows.length.toLocaleString()} committed rows
        </div>
      </div>

      <div role="tabpanel">
        {view === "checks" ? (
          <ChecksView rows={rows} visibility={visibility} />
        ) : (
          <TransactionsGrid
            rows={rows}
            canManage={canManage}
            visibility={visibility}
            canSeeBudgets={canSeeBudgets}
            initialFilters={initialFilters}
            contextLabel={contextLabel}
          />
        )}
      </div>
    </div>
  );
}

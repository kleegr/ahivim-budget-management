"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ListChecks, RotateCcw, Search, TableProperties } from "lucide-react";
import { dec, formatHours, formatMoney } from "@/lib/money";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { TransactionFieldVisibility } from "@/lib/auth/money-redaction";
import type { FilterState } from "@/components/data-grid/types";
import PeriodControl, { type PeriodRange } from "@/components/period-control";
import { Card, EmptyState, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import {
  groupChecks,
  type CheckRouting,
  type CheckSummary,
} from "@/components/transactions/check-grouping";
import TransactionsGrid from "@/components/transactions/transactions-grid";

type WorkspaceView = "checks" | "rows";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

const dateLabel = (value: string | null): string => {
  if (!value) return "Date missing";
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00`));
};

const routingLabel = (routing: CheckRouting) => {
  if (routing === "direct") return <StatusBadge tone="info" label="Direct to employee" />;
  if (routing === "agency") return <StatusBadge tone="good" label="Agency-routed" />;
  return <StatusBadge tone="warn" label="Routing review" />;
};

function checkRowsHref(check: CheckSummary): string {
  const params = new URLSearchParams({ view: "rows" });
  if (check.transactionIds.length <= 200) {
    for (const id of check.transactionIds) params.append("transactionId", id);
    return `/transactions?${params.toString()}`;
  }
  if (check.checkNumber) params.set("checkNumber", check.checkNumber);
  if (check.payTo) params.set("payToKey", check.payTo.trim().toLocaleLowerCase());
  else if (check.employeeId) params.set("employeeId", check.employeeId);
  else if (check.employee) params.set("employee", check.employee);
  if (check.checkDate) params.set("period", `${check.checkDate}..${check.checkDate}`);
  else {
    if (check.periodBegin) params.set("pbFrom", check.periodBegin);
    if (check.periodEnd) params.set("pbTo", check.periodEnd);
  }
  return `/transactions?${params.toString()}`;
}

function ChecksView({
  rows,
  visibility,
  onShowRows,
}: {
  rows: GridTransaction[];
  visibility: TransactionFieldVisibility;
  onShowRows: () => void;
}) {
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<PeriodRange>(null);
  const [periodControlKey, setPeriodControlKey] = useState(0);
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

  const clearViewFilters = () => {
    setQuery("");
    setPeriod(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("period");
      window.history.replaceState(null, "", url.toString());
    }
    setPeriodControlKey((key) => key + 1);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PeriodControl key={periodControlKey} onChange={setPeriod} paramKey="period" />
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Search checks</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search checks"
            className="input input-leading-icon w-full"
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
          <EmptyState
            title="No checks match this view"
            compact
            action={(
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" className="btn btn-sm btn-secondary" onClick={clearViewFilters}>
                  <RotateCcw aria-hidden className="h-4 w-4" /> Clear period and search
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onShowRows}>
                  <TableProperties aria-hidden className="h-4 w-4" /> View transaction rows
                </button>
              </div>
            )}
          >
            {rows.length.toLocaleString()} committed transaction {rows.length === 1 ? "row is" : "rows are"} loaded, but the current period or search hides them.
          </EmptyState>
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
                    <Link href={checkRowsHref(check)} className="btn btn-sm btn-ghost whitespace-nowrap">
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
  initialView = "checks",
}: {
  rows: GridTransaction[];
  canManage: boolean;
  visibility: TransactionFieldVisibility;
  canSeeBudgets: boolean;
  initialFilters?: FilterState;
  contextLabel?: string | null;
  initialView?: WorkspaceView;
}) {
  const [view, setView] = useState<WorkspaceView>(contextLabel ? "rows" : initialView);

  const selectView = (nextView: WorkspaceView) => {
    setView(nextView);
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    window.history.replaceState(null, "", url.toString());
  };

  return (
    <div className="space-y-4">
      {!contextLabel ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="segmented-control" role="tablist" aria-label="Transaction views">
            <button
              id="transactions-rows-tab"
              type="button"
              role="tab"
              aria-selected={view === "rows"}
              aria-controls="transactions-workspace-panel"
              onClick={() => selectView("rows")}
            >
              <TableProperties aria-hidden className="h-4 w-4" /> Transactions
            </button>
            <button
              id="transactions-checks-tab"
              type="button"
              role="tab"
              aria-selected={view === "checks"}
              aria-controls="transactions-workspace-panel"
              onClick={() => selectView("checks")}
            >
              <ListChecks aria-hidden className="h-4 w-4" /> Payroll checks
            </button>
          </div>
          <p className="text-xs text-[var(--color-ink-faint)]">
            {view === "checks" ? "One line per check" : `${rows.length.toLocaleString()} transactions`}
          </p>
        </div>
      ) : null}

      <div
        id="transactions-workspace-panel"
        role="tabpanel"
        aria-labelledby={contextLabel ? undefined : view === "rows" ? "transactions-rows-tab" : "transactions-checks-tab"}
      >
        {view === "checks" ? (
          <ChecksView rows={rows} visibility={visibility} onShowRows={() => selectView("rows")} />
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

"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { Download, RotateCcw, Search, TableProperties } from "lucide-react";
import type { TransactionFieldVisibility } from "@/lib/auth/money-redaction";
import { normalizePayee } from "@/lib/business/internal-rate";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { ExportCell, ExportColumn } from "@/lib/export/tabular";
import { dec, formatHours, formatMoney } from "@/lib/money";
import PeriodControl, { type PeriodRange } from "@/components/period-control";
import {
  groupSourcePayments,
  type SourcePaymentSummary,
} from "@/components/transactions/source-payment-grouping";
import { downloadTransactionSummary } from "@/components/transactions/summary-export";
import { Card, EmptyState, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const dateLabel = (value: string | null): string => {
  if (!value) return "Date missing";
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`));
};

export function sourcePaymentRowsHref(payment: SourcePaymentSummary): string {
  const params = new URLSearchParams({
    view: "rows",
    sourcePaymentIdentity: payment.key,
  });
  if (payment.payTo) params.set("payToKey", normalizePayee(payment.payTo));
  if (payment.checkNumber) params.set("checkNumber", payment.checkNumber);
  else params.set("checkNumberExact", "");
  if (payment.checkDate) {
    params.set("checkDateFrom", payment.checkDate);
    params.set("checkDateTo", payment.checkDate);
  } else params.set("checkDateExact", "");
  params.set("periodBeginExact", payment.periodBegin ?? "");
  params.set("periodEndExact", payment.periodEnd ?? "");
  return `/transactions?${params.toString()}`;
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4">
      <div className="eyebrow truncate">{label}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-[var(--color-ink)]">{value}</div>
    </div>
  );
}

function paidBadge(payment: SourcePaymentSummary) {
  if (payment.paidStatus === "paid") return <StatusBadge tone="good" label="Paid" />;
  if (payment.paidStatus === "mixed") return <StatusBadge tone="warn" label="Mixed" />;
  return <StatusBadge tone="muted" label="Not paid" />;
}

export default function SourcePaymentsView({
  rows,
  visibility,
  onShowRows,
}: {
  rows: GridTransaction[];
  visibility: TransactionFieldVisibility;
  onShowRows: () => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [period, setPeriod] = useState<PeriodRange>(null);
  const [periodControlKey, setPeriodControlKey] = useState(0);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const payments = useMemo(() => groupSourcePayments(rows), [rows]);
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return payments.filter((payment) => {
      if (period && (!payment.checkDate || payment.checkDate < period.from || payment.checkDate > period.to)) return false;
      if (!needle) return true;
      return [
        payment.checkNumber,
        payment.payTo,
        ...payment.employees,
        ...payment.individuals,
        ...payment.programs,
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
    });
  }, [deferredQuery, payments, period]);

  const totals = useMemo(() => filtered.reduce((result, payment) => ({
    rows: result.rows + payment.rows,
    funderBilled: result.funderBilled.plus(payment.funderBilled),
    employeeBase: result.employeeBase.plus(payment.employeeBase),
    agencySpread: result.agencySpread.plus(payment.agencySpread),
    sourceNet: result.sourceNet.plus(payment.sourceNet ?? 0),
    knownNetPayments: result.knownNetPayments + (payment.sourceNet === null ? 0 : 1),
    hours: result.hours.plus(payment.hours),
  }), {
    rows: 0,
    funderBilled: dec(0),
    employeeBase: dec(0),
    agencySpread: dec(0),
    sourceNet: dec(0),
    knownNetPayments: 0,
    hours: dec(0),
  }), [filtered]);
  const employeeCheckCount = useMemo(
    () => new Set(filtered.flatMap((payment) => payment.employeeCheckIdentities)).size,
    [filtered],
  );

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

  const exportView = async (format: "csv" | "xlsx") => {
    setExporting(format);
    setNotice(null);
    const columns: ExportColumn[] = [
      { key: "checkNumber", header: "Check #", type: "text" },
      { key: "checkDate", header: "Check date", type: "date" },
      { key: "payTo", header: "Pay to", type: "text" },
      { key: "periodBegin", header: "Period begin", type: "date" },
      { key: "periodEnd", header: "Period end", type: "date" },
      { key: "employees", header: "Employees", type: "text" },
      { key: "employeeChecks", header: "Employee checks", type: "int" },
      { key: "individuals", header: "People served", type: "text" },
      { key: "programs", header: "Programs", type: "text" },
      { key: "services", header: "Recorded services", type: "int" },
      ...(visibility.canSeeHours ? [{ key: "hours", header: "Hours", type: "hours" } as const] : []),
      ...(visibility.canSeeBilledAmounts ? [{ key: "funderBilled", header: "Funder billed", type: "money" } as const] : []),
      ...(visibility.canSeeEmployeeAmounts ? [{ key: "employeeBase", header: "Employee base", type: "money" } as const] : []),
      ...(visibility.canSeeAgencySpread ? [{ key: "agencySpread", header: "Agency spread", type: "money" } as const] : []),
      ...(visibility.canSeeCheckNet ? [{ key: "sourceNet", header: "Source net", type: "money" } as const] : []),
      { key: "paid", header: "Paid", type: "text" },
      { key: "review", header: "Review status", type: "text" },
    ];
    const exportRows: Record<string, ExportCell>[] = filtered.map((payment) => ({
      checkNumber: payment.checkNumber,
      checkDate: payment.checkDate,
      payTo: payment.payTo ?? (payment.employees.length === 1 ? payment.employees[0]! : null),
      periodBegin: payment.periodBegin,
      periodEnd: payment.periodEnd,
      employees: payment.employees.join(", "),
      employeeChecks: payment.employeeChecks,
      individuals: payment.individuals.join(", "),
      programs: payment.programs.join(", "),
      services: payment.rows,
      hours: payment.hours,
      funderBilled: payment.funderBilled,
      employeeBase: payment.employeeBase,
      agencySpread: payment.agencySpread,
      sourceNet: payment.sourceNet,
      paid: payment.paidStatus === "paid" ? "Paid" : payment.paidStatus === "mixed" ? "Mixed" : "Not paid",
      review: payment.needsReview ? payment.reviewReasons.join("; ") : "Ready",
    }));
    try {
      await downloadTransactionSummary({
        format,
        title: "Source payments",
        filename: "source-payments",
        columns,
        rows: exportRows,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not export source payments.");
    } finally {
      setExporting(null);
    }
  };

  const sourceNetLabel = totals.knownNetPayments === filtered.length
    ? "Source net"
    : `Known source net (${totals.knownNetPayments}/${filtered.length})`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PeriodControl key={periodControlKey} onChange={setPeriod} paramKey="period" />
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <label className="relative block min-w-56 flex-1 sm:w-72">
            <span className="sr-only">Search source payments</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search source payments"
              className="input input-leading-icon w-full"
            />
          </label>
          <button type="button" className="btn btn-sm btn-secondary" disabled={exporting !== null} onClick={() => exportView("csv")}>
            <Download aria-hidden className="h-4 w-4" /> {exporting === "csv" ? "Exporting…" : "CSV"}
          </button>
          <button type="button" className="btn btn-sm btn-secondary" disabled={exporting !== null} onClick={() => exportView("xlsx")}>
            <Download aria-hidden className="h-4 w-4" /> {exporting === "xlsx" ? "Exporting…" : "Excel"}
          </button>
        </div>
      </div>

      {notice ? <p role="alert" className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{notice}</p> : null}

      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)] sm:grid-cols-3 lg:grid-cols-8 lg:divide-y-0">
        <SummaryMetric label="Source payments" value={filtered.length.toLocaleString()} />
        <SummaryMetric label="Employee checks" value={employeeCheckCount.toLocaleString()} />
        <SummaryMetric label="Recorded services" value={totals.rows.toLocaleString()} />
        {visibility.canSeeBilledAmounts ? <SummaryMetric label="Funder billed" value={formatMoney(totals.funderBilled)} /> : null}
        {visibility.canSeeEmployeeAmounts ? <SummaryMetric label="Employee base" value={formatMoney(totals.employeeBase)} /> : null}
        {visibility.canSeeAgencySpread ? <SummaryMetric label="Agency spread" value={formatMoney(totals.agencySpread)} /> : null}
        {visibility.canSeeCheckNet ? <SummaryMetric label={sourceNetLabel} value={formatMoney(totals.sourceNet)} /> : null}
        {visibility.canSeeHours ? <SummaryMetric label="Hours" value={formatHours(totals.hours)} /> : null}
      </div>

      <Card>
        {filtered.length === 0 ? (
          <EmptyState
            title="No source payments match this view"
            compact
            action={(
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" className="btn btn-sm btn-secondary" onClick={clearViewFilters}>
                  <RotateCcw aria-hidden className="h-4 w-4" /> Clear period and search
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onShowRows}>
                  <TableProperties aria-hidden className="h-4 w-4" /> View recorded services
                </button>
              </div>
            )}
          >
            {rows.length.toLocaleString()} recorded {rows.length === 1 ? "service is" : "services are"} loaded, but the current period or search hides their payments.
          </EmptyState>
        ) : (
          <Table
            caption="Imported source payments and the employee checks they cover"
            head={<>
              <Th>Payment</Th>
              <Th>Pay to</Th>
              <Th>Pay period</Th>
              <Th>Employees</Th>
              <Th numeric>Employee checks</Th>
              <Th>People served</Th>
              <Th numeric>Services</Th>
              {visibility.canSeeHours ? <Th numeric>Hours</Th> : null}
              {visibility.canSeeBilledAmounts ? <Th numeric>Funder billed</Th> : null}
              {visibility.canSeeEmployeeAmounts ? <Th numeric>Employee base</Th> : null}
              {visibility.canSeeAgencySpread ? <Th numeric>Agency spread</Th> : null}
              {visibility.canSeeCheckNet ? <Th numeric>Source net</Th> : null}
              <Th>Paid</Th>
              <Th>Status</Th>
              <Th><span className="sr-only">Open</span></Th>
            </>}
          >
            {filtered.map((payment) => (
              <Tr key={payment.key}>
                <Td>
                  <div className="font-semibold text-[var(--color-ink)]">{payment.checkNumber ? `#${payment.checkNumber}` : "Number missing"}</div>
                  <div className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{dateLabel(payment.checkDate)}</div>
                </Td>
                <Td>{payment.payTo ?? (payment.employees.length === 1 ? payment.employees[0] : "Recipient missing")}</Td>
                <Td>{payment.periodBegin || payment.periodEnd ? `${dateLabel(payment.periodBegin)} to ${dateLabel(payment.periodEnd)}` : "Period missing"}</Td>
                <Td>
                  <span className="font-medium text-[var(--color-ink)]">{payment.employees.length.toLocaleString()}</span>
                  <div className="mt-0.5 max-w-52 truncate text-xs text-[var(--color-ink-faint)]" title={payment.employees.join(", ")}>{payment.employees.join(", ") || "Unmatched"}</div>
                </Td>
                <Td numeric>{payment.employeeChecks.toLocaleString()}</Td>
                <Td>
                  <span className="font-medium text-[var(--color-ink)]">{payment.individuals.length.toLocaleString()}</span>
                  <div className="mt-0.5 max-w-52 truncate text-xs text-[var(--color-ink-faint)]" title={payment.individuals.join(", ")}>{payment.individuals.join(", ") || "Unmatched"}</div>
                </Td>
                <Td numeric>{payment.rows.toLocaleString()}</Td>
                {visibility.canSeeHours ? <Td numeric>{formatHours(payment.hours)}</Td> : null}
                {visibility.canSeeBilledAmounts ? <Td numeric>{formatMoney(payment.funderBilled)}</Td> : null}
                {visibility.canSeeEmployeeAmounts ? <Td numeric>{formatMoney(payment.employeeBase)}</Td> : null}
                {visibility.canSeeAgencySpread ? <Td numeric>{formatMoney(payment.agencySpread)}</Td> : null}
                {visibility.canSeeCheckNet ? <Td numeric>{payment.sourceNet !== null ? formatMoney(payment.sourceNet) : <span className="text-[var(--color-ink-faint)]">Review</span>}</Td> : null}
                <Td>{paidBadge(payment)}</Td>
                <Td>
                  <StatusBadge tone={payment.needsReview ? "warn" : "good"} label={payment.needsReview ? "Needs review" : "Ready"} />
                  {payment.needsReview ? <div className="mt-1 max-w-48 text-xs text-[var(--color-ink-faint)]">{payment.reviewReasons.join(" · ")}</div> : null}
                </Td>
                <Td>
                  <Link href={sourcePaymentRowsHref(payment)} className="btn btn-sm btn-ghost whitespace-nowrap">
                    {payment.needsReview ? "Review" : "Open"} {payment.rows.toLocaleString()} {payment.rows === 1 ? "service" : "services"}
                  </Link>
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

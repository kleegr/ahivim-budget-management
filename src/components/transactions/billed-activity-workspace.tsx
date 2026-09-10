"use client";

import { investigationDrillHref, InvestigationCheckDates, type InvestigationScope } from "./investigation-scope";

import { useCallback, useDeferredValue, useMemo, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import TransactionsGrid, { TRANSACTION_COLUMNS } from "./transactions-grid";
import { applyFilters, filterChips } from "@/components/data-grid/engine";
import Link from "next/link";
import { CheckCircle2, Download, ListChecks, ReceiptText, RefreshCw, RotateCcw, Search, ShieldAlert, TableProperties } from "lucide-react";
import { dec, formatHours, formatMoney } from "@/lib/money";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { ActivityReviewSummary } from "@/lib/data/activity-overview";
import type { TransactionFieldVisibility } from "@/lib/auth/money-redaction";
import type { FilterState } from "@/components/data-grid/types";
import PeriodControl, { type PeriodRange } from "@/components/period-control";
import { Card, EmptyState, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import {
  groupChecks,
  sumKnownAmounts,
  type CheckMoneyField,
  type CheckRouting,
  type CheckSummary,
} from "@/components/transactions/check-grouping";
import SourcePaymentsView from "@/components/transactions/source-payments-view";
import { buildCheckExport } from "./check-export";
import { downloadTransactionSummary } from "@/components/transactions/summary-export";

type WorkspaceView = "checks" | "source-payments" | "rows";
const WORKSPACE_VIEWS: WorkspaceView[] = ["rows", "checks", "source-payments"];

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

const routingLabel = (routing: CheckRouting) => {
  if (routing === "direct") return <StatusBadge tone="info" label="Direct to employee" />;
  if (routing === "agency") return <StatusBadge tone="good" label="Agency-routed" />;
  return <StatusBadge tone="warn" label="Routing review" />;
};

const VERIFICATION_LABEL: Record<string, string> = {
  unverified: "Needs verification",
  verified: "Verified",
  void: "Void",
};

function checkMoneyLabel(check: CheckSummary, field: CheckMoneyField): string {
  const value = check[field];
  if (value === null) return "Unavailable";
  return `${formatMoney(value)}${check.completeness[field].missing > 0 ? " · incomplete subtotal" : ""}`;
}

function totalMoneyLabel(checks: CheckSummary[], field: CheckMoneyField | "verifiedCheckGross" | "verifiedCheckNet" | "withholding"): string {
  const total = sumKnownAmounts(checks.map((check) => check[field]));
  if (total.amount === null) return "Unavailable";
  const incomplete = total.missing > 0 || checks.some((check) => field in check.completeness && check.completeness[field as CheckMoneyField].missing > 0);
  return `${formatMoney(total.amount)}${incomplete ? " · incomplete subtotal" : ""}`;
}

function checkRowsHref(check: CheckSummary): string {
  const params = new URLSearchParams({ view: "rows" });
  // The stable grouping key is the final guard against display-value quirks
  // (for example whitespace around a source check number). The component
  // filters below remain present so operators can see every identity part.
  params.set("checkIdentity", check.key);
  if (check.checkNumber) params.set("checkNumber", check.checkNumber);
  else params.set("checkNumberExact", "");
  if (check.employeeId) params.set("employeeId", check.employeeId);
  else if (check.employee) params.set("employee", check.employee);
  else params.set("employeeExact", "");
  if (check.checkDate) {
    params.set("checkDateFrom", check.checkDate);
    params.set("checkDateTo", check.checkDate);
  } else params.set("checkDateExact", "");
  // Complete check identity uses both exact period bounds. These are distinct
  // from pbFrom/pbTo, whose established meaning is a Period Begin range for
  // budget/report links.
  params.set("periodBeginExact", check.periodBegin ?? "");
  params.set("periodEndExact", check.periodEnd ?? "");
  return `/transactions?${params.toString()}`;
}

function ChecksView({
  rows,
  visibility,
  onShowRows,
  scope,
}: {
  rows: GridTransaction[];
  visibility: TransactionFieldVisibility;
  onShowRows: () => void;
  scope?: InvestigationScope;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const query = scope?.search ?? localQuery;
  const setQuery = (value: string) => scope ? scope.onChange({ filters: scope.filters, search: value }) : setLocalQuery(value);
  const deferredQuery = useDeferredValue(query);
  const [period, setPeriod] = useState<PeriodRange>(null);
  const [periodControlKey, setPeriodControlKey] = useState(0);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const checks = useMemo(() => groupChecks(rows), [rows]);
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
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
  }, [checks, deferredQuery, period]);

  const totals = useMemo(() => filtered.reduce((result, check) => ({
    funderBilled: result.funderBilled.plus(check.funderBilled ?? 0),
    employeeBase: result.employeeBase.plus(check.employeeBase ?? 0),
    agencySpread: result.agencySpread.plus(check.agencySpread ?? 0),
    verifiedGross: result.verifiedGross.plus(check.verifiedCheckGross ?? 0),
    verifiedNet: result.verifiedNet.plus(check.verifiedCheckNet ?? 0),
    withholding: result.withholding.plus(check.withholding ?? 0),
    hours: result.hours.plus(check.hours),
  }), {
    funderBilled: dec(0),
    employeeBase: dec(0),
    agencySpread: dec(0),
    verifiedGross: dec(0),
    verifiedNet: dec(0),
    withholding: dec(0),
    hours: dec(0),
  }), [filtered]);

  const clearViewFilters = () => {
    if (scope) { const filters = { ...scope.filters }; delete filters.checkDate; scope.onChange({ filters, search: "" }); return; }
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
    const { columns, rows: exportRows } = buildCheckExport(filtered, visibility);
    try {
      await downloadTransactionSummary({
        format,
        title: "Payroll checks",
        filename: "payroll-checks",
        columns,
        rows: exportRows,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not export payroll checks.");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {scope ? <InvestigationCheckDates scope={scope} /> : <PeriodControl key={periodControlKey} onChange={setPeriod} paramKey="period" />}
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <label className="relative block min-w-56 flex-1 sm:w-72">
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
        <SummaryMetric label="Checks" value={filtered.length.toLocaleString()} />
        {visibility.canSeeBilledAmounts ? <SummaryMetric label="Funder billed" value={totalMoneyLabel(filtered, "funderBilled")} /> : null}
        {visibility.canSeeEmployeeAmounts ? <SummaryMetric label="Employee base" value={totalMoneyLabel(filtered, "employeeBase")} /> : null}
        {visibility.canSeeAgencySpread ? <SummaryMetric label="Agency spread" value={totalMoneyLabel(filtered, "agencySpread")} /> : null}
        {visibility.canSeeCheckGross ? <SummaryMetric label="Verified gross" value={totalMoneyLabel(filtered, "verifiedCheckGross")} /> : null}
        {visibility.canSeeCheckNet ? <SummaryMetric label="Verified net" value={totalMoneyLabel(filtered, "verifiedCheckNet")} /> : null}
        {visibility.canSeeTaxes ? <SummaryMetric label="Withholding" value={totalMoneyLabel(filtered, "withholding")} /> : null}
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
                  <TableProperties aria-hidden className="h-4 w-4" /> View recorded services
                </button>
              </div>
            )}
          >
            {rows.length.toLocaleString()} recorded {rows.length === 1 ? "service is" : "services are"} loaded, but the current period or search hides them.
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
              {visibility.canSeeCheckGross ? <Th numeric>Verified gross</Th> : null}
              {visibility.canSeeCheckNet ? <Th numeric>Verified net</Th> : null}
              {visibility.canSeeTaxes ? <Th numeric>Withholding</Th> : null}
              {visibility.canSeeCheckGross || visibility.canSeeCheckNet ? <Th>Verification</Th> : null}
              {visibility.canSeeCheckNet ? <Th numeric>Source net</Th> : null}
              <Th>Status</Th>
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
                {visibility.canSeeBilledAmounts ? <Td numeric>{checkMoneyLabel(check, "funderBilled")}</Td> : null}
                {visibility.canSeeEmployeeAmounts ? <Td numeric>{checkMoneyLabel(check, "employeeBase")}</Td> : null}
                {visibility.canSeeAgencySpread ? <Td numeric>{checkMoneyLabel(check, "agencySpread")}</Td> : null}
                {visibility.canSeeCheckGross ? <Td numeric>{check.verifiedCheckGross !== null ? formatMoney(check.verifiedCheckGross) : <span className="text-[var(--color-ink-faint)]">-</span>}</Td> : null}
                {visibility.canSeeCheckNet ? <Td numeric>{check.verifiedCheckNet !== null ? formatMoney(check.verifiedCheckNet) : <span className="text-[var(--color-ink-faint)]">-</span>}</Td> : null}
                {visibility.canSeeTaxes ? <Td numeric>{check.withholding !== null ? formatMoney(check.withholding) : <span className="text-[var(--color-ink-faint)]">-</span>}</Td> : null}
                {visibility.canSeeCheckGross || visibility.canSeeCheckNet ? (
                  <Td>{check.verificationStatus === null ? "Not linked" : VERIFICATION_LABEL[check.verificationStatus] ?? check.verificationStatus}</Td>
                ) : null}
                {visibility.canSeeCheckNet ? <Td numeric>{check.netPay !== null ? formatMoney(check.netPay) : <span className="text-[var(--color-ink-faint)]">-</span>}</Td> : null}
                <Td>
                  <StatusBadge tone={check.needsReview ? "warn" : "good"} label={check.needsReview ? "Needs review" : "Ready"} />
                  {check.needsReview ? <div className="mt-1 max-w-44 text-xs text-[var(--color-ink-faint)]">{check.reviewReasons.join(" · ")}</div> : null}
                </Td>
                <Td>
                  <Link href={investigationDrillHref(checkRowsHref(check), scope, { checkIdentity: { selected: [check.key] } })} className="btn btn-sm btn-ghost whitespace-nowrap">
                    {check.needsReview ? "Review" : "Open"} {check.rows.toLocaleString()} {check.rows === 1 ? "service" : "services"}
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

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4">
      <div className="eyebrow truncate">{label}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold text-[var(--color-ink)]">{value}</div>
    </div>
  );
}

type DecisionLink = { key: string; count: number; label: string; href: string };

function decisionLinks(summary: ActivityReviewSummary): DecisionLink[] {
  const { decisions } = summary;
  return [
    {
      key: "source",
      count: decisions.changedSourceRecords + decisions.missingSourceRecords,
      label: "source changes",
      href: "/sync#sync-conflicts",
    },
    { key: "people", count: decisions.unmatchedNames, label: "names to identify", href: "/exceptions?kind=unmatched_name" },
    { key: "programs", count: decisions.unknownPrograms, label: "programs to choose", href: "/exceptions?kind=unknown_program" },
    { key: "aliases", count: decisions.pendingAliases, label: "names to approve", href: "/aliases?status=pending" },
    { key: "duplicates", count: decisions.duplicatePeople, label: "possible duplicate people", href: "/matches" },
    { key: "totals", count: decisions.totalDifferences, label: "totals to compare", href: "/imports?view=reconciliation" },
  ].filter((item) => item.count > 0);
}

function ActivityStartingPoint({
  rows,
  canManage,
  reviewSummary,
}: {
  rows: GridTransaction[];
  canManage: boolean;
  reviewSummary?: ActivityReviewSummary | null;
}) {
  if (!canManage) return null;
  const checkCount = groupChecks(rows).length;
  const latestService = rows.reduce<string | null>((latest, row) => (
    row.serviceDate && (!latest || row.serviceDate > latest) ? row.serviceDate : latest
  ), null);
  const items = reviewSummary ? decisionLinks(reviewSummary) : [];
  const hasDecisions = Boolean(reviewSummary && reviewSummary.decisionTotal > 0);

  return (
    <section aria-label="Activity status" className="rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${hasDecisions ? "bg-[var(--color-warn-soft)] text-[var(--color-warn)]" : "bg-[var(--color-success-soft)] text-[var(--color-success)]"}`}>
            {hasDecisions ? <ShieldAlert aria-hidden className="h-4 w-4" /> : <CheckCircle2 aria-hidden className="h-4 w-4" />}
          </span>
          <div>
            <p className="font-semibold text-[var(--color-ink)]">
              {reviewSummary
                ? hasDecisions
                  ? `${reviewSummary.decisionTotal.toLocaleString()} decision${reviewSummary.decisionTotal === 1 ? "" : "s"} need attention`
                  : "Recorded activity is ready"
                : "Recorded activity is available"}
            </p>
            <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
              {reviewSummary
                ? hasDecisions
                  ? "Resolve the questions below; services already recorded remain visible in the meantime."
                  : "No source, identity, or program decisions are waiting."
                : "Review status could not be checked, but the services below are still available."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasDecisions ? <Link href="/review" className="btn btn-sm btn-primary">Review decisions</Link> : null}
          <Link href="/sync" className={`btn btn-sm ${hasDecisions ? "btn-secondary" : "btn-primary"}`}>
            <RefreshCw aria-hidden className="h-4 w-4" /> Update activity
          </Link>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--color-rule)] pt-2 text-xs text-[var(--color-ink-soft)]">
        <span><strong className="tnum text-[var(--color-ink)]">{rows.length.toLocaleString()}</strong> recorded services</span>
        <span><strong className="tnum text-[var(--color-ink)]">{checkCount.toLocaleString()}</strong> payroll checks</span>
        <span>Latest service <strong className="text-[var(--color-ink)]">{dateLabel(latestService)}</strong></span>
      </div>

      {items.length > 0 ? (
        <nav aria-label="Decisions waiting" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {items.map((item) => (
            <Link key={item.key} href={item.href} className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline">
              {item.count.toLocaleString()} {item.label} →
            </Link>
          ))}
        </nav>
      ) : null}
    </section>
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
  reviewSummary,
}: {
  rows: GridTransaction[];
  canManage: boolean;
  visibility: TransactionFieldVisibility;
  canSeeBudgets: boolean;
  initialFilters?: FilterState;
  contextLabel?: string | null;
  initialView?: WorkspaceView;
  reviewSummary?: ActivityReviewSummary | null;
}) {
  const params = useSearchParams();
  const savedScope = params.get("scope");
  const scopeValues = useMemo(() => {
    try {
      const parsed = savedScope ? JSON.parse(savedScope) as { filters?: FilterState; search?: string } : null;
      if (parsed && parsed.filters && typeof parsed.filters === "object" && !Array.isArray(parsed.filters)) {
        const filters: FilterState = {};
        for (const [key, value] of Object.entries(parsed.filters)) {
          if (!TRANSACTION_COLUMNS.some((column) => column.key === key) || !value || typeof value !== "object") continue;
          filters[key] = {
            ...(Array.isArray(value.selected) ? { selected: value.selected.filter((entry) => typeof entry === "string") } : {}),
            ...Object.fromEntries(Object.entries(value).filter(([field, entry]) => ["contains", "min", "max", "from", "to", "dateGroup"].includes(field) && typeof entry === "string")),
          };
        }
        return { filters, search: typeof parsed.search === "string" ? parsed.search : "" };
      }
    } catch { /* Ignore invalid saved context and use the explicit route scope. */ }
    return { filters: initialFilters ?? {}, search: "" };
  }, [savedScope, initialFilters]);
  const onScopeChange = useCallback((next: { filters: FilterState; search: string }) => {
    const url = new URL(window.location.href);
    url.searchParams.set("scope", JSON.stringify(next));
    window.history.replaceState(null, "", url.toString());
  }, []);
  const scope = useMemo(() => ({ ...scopeValues, onChange: onScopeChange }), [scopeValues, onScopeChange]);
  const scopedRows = useMemo(() => applyFilters(rows, TRANSACTION_COLUMNS, scope.filters, scope.search, ["individual", "employee", "program", "payTo", "checkNumber"]), [rows, scope.filters, scope.search]);
  const scopeChips = useMemo(() => filterChips(TRANSACTION_COLUMNS, scope.filters), [scope.filters]);
  const requestedView = params.get("view") as WorkspaceView | null;
  const view = requestedView && WORKSPACE_VIEWS.includes(requestedView) ? requestedView : contextLabel ? "rows" : initialView;
  const selectView = (nextView: WorkspaceView) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    window.history.pushState(null, "", url.toString());
  };

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = WORKSPACE_VIEWS.indexOf(view);
    const nextView = event.key === "Home"
      ? WORKSPACE_VIEWS[0]!
      : event.key === "End"
        ? WORKSPACE_VIEWS.at(-1)!
        : event.key === "ArrowLeft"
          ? WORKSPACE_VIEWS[(currentIndex - 1 + WORKSPACE_VIEWS.length) % WORKSPACE_VIEWS.length]!
          : event.key === "ArrowRight"
            ? WORKSPACE_VIEWS[(currentIndex + 1) % WORKSPACE_VIEWS.length]!
            : null;
    if (!nextView) return;
    event.preventDefault();
    selectView(nextView);
    window.requestAnimationFrame(() => {
      document.getElementById(`transactions-${nextView}-tab`)?.focus();
    });
  };

  return (
    <div className="space-y-4">
      {!contextLabel ? <ActivityStartingPoint rows={rows} canManage={canManage} reviewSummary={reviewSummary} /> : null}
      {!contextLabel ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="segmented-control" role="tablist" aria-label="Transaction views">
            <button
              id="transactions-rows-tab"
              type="button"
              role="tab"
              aria-selected={view === "rows"}
              tabIndex={view === "rows" ? 0 : -1}
              aria-controls="transactions-workspace-panel"
              onKeyDown={moveTabFocus}
              onClick={() => selectView("rows")}
            >
              <TableProperties aria-hidden className="h-4 w-4" /> Recorded services
            </button>
            <button
              id="transactions-checks-tab"
              type="button"
              role="tab"
              aria-selected={view === "checks"}
              tabIndex={view === "checks" ? 0 : -1}
              aria-controls="transactions-workspace-panel"
              onKeyDown={moveTabFocus}
              onClick={() => selectView("checks")}
            >
              <ListChecks aria-hidden className="h-4 w-4" /> Payroll checks
            </button>
            <button
              id="transactions-source-payments-tab"
              type="button"
              role="tab"
              aria-selected={view === "source-payments"}
              tabIndex={view === "source-payments" ? 0 : -1}
              aria-controls="transactions-workspace-panel"
              onKeyDown={moveTabFocus}
              onClick={() => selectView("source-payments")}
            >
              <ReceiptText aria-hidden className="h-4 w-4" /> Source payments
            </button>
          </div>
          <p className="text-xs text-[var(--color-ink-faint)]">
            {view === "checks"
              ? "One line per employee check"
              : view === "source-payments"
                ? "One line per imported payment"
                : `${rows.length.toLocaleString()} recorded services`}
          </p>
        </div>
      ) : null}

      {(scopeChips.length > 0 || scope.search) ? <section aria-label="Investigation scope" className="rounded-lg border border-[var(--color-primary)] bg-[var(--color-primary-tint)] px-4 py-3 text-sm">
        <p className="font-semibold">{scopedRows.length.toLocaleString()} selected services across every view</p>
        <p className="mt-1 break-words">{scopeChips.map((chip) => chip.label).join(" · ")}{scope.search ? ` · Search: ${scope.search}` : ""}</p>
        <p className="mt-1 text-xs">Service amounts below reflect this selection. Check gross, net, and source-payment amounts describe the whole check, which may also cover other people or programs.</p>
        <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn btn-sm btn-secondary" onClick={() => selectView("rows")}>Edit scope in services</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => onScopeChange({ filters: {}, search: "" })}>Clear investigation scope</button></div>
      </section> : null}
      <div
        id="transactions-workspace-panel"
        role="tabpanel"
        aria-labelledby={contextLabel ? undefined : `transactions-${view}-tab`}
      >
        {view === "checks" ? (
          <ChecksView scope={scope} rows={scopedRows} visibility={visibility} onShowRows={() => selectView("rows")} />
        ) : view === "source-payments" ? (
          <SourcePaymentsView scope={scope} rows={scopedRows} visibility={visibility} onShowRows={() => selectView("rows")} />
        ) : (
          <TransactionsGrid
            rows={rows}
            canManage={canManage}
            visibility={visibility}
            canSeeBudgets={canSeeBudgets}
            initialFilters={initialFilters}
            scope={scope}
            contextLabel={contextLabel}
          />
        )}
      </div>
    </div>
  );
}

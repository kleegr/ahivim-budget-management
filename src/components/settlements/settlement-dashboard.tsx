"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useDeferredValue, useMemo, useState } from "react";
import { FilterBar, HeaderFilter } from "@/components/data-grid/filter-bar";
import SortMenu from "@/components/data-grid/sort-menu";
import { Toolbar } from "@/components/data-grid/toolbar";
import { isNumericKind, type ColumnDef, type FilterState } from "@/components/data-grid/types";
import { useGrid, type UseGridResult } from "@/components/data-grid/use-grid";
import { Modal } from "@/components/manage/client";
import { PaceBar } from "@/components/ui";
import type {
  DirectCheckIssue,
  SettlementDashboardData,
  SettlementEventRow,
  SettlementRow,
} from "@/lib/data/settlements";
import { dec, formatMoney, type Decimal } from "@/lib/money";

type View = "items" | "history";
type StateFilter = "needs_action" | "open" | "partial" | "settled" | "credit" | "void" | "all";
type Notice = { tone: "success" | "error"; message: string };

interface RefreshResult {
  created: number;
  updated: number;
  adjusted: number;
  voided: number;
  unchanged: number;
  skippedNoDeal: number;
  skippedMissingCheckIdentity: number;
  skippedMissingNet: number;
  skippedInconsistentNet: number;
  skippedInconsistentCheck: number;
  skippedMissingBase: number;
  skippedUnknownRecipient: number;
}

interface ApiPayload<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const STATE_FILTERS: { value: StateFilter; label: string }[] = [
  { value: "needs_action", label: "Needs action" },
  { value: "open", label: "Open" },
  { value: "partial", label: "Partial" },
  { value: "settled", label: "Settled" },
  { value: "credit", label: "Credits" },
  { value: "void", label: "Void" },
  { value: "all", label: "All" },
];

const STATE_STYLES: Record<SettlementRow["state"], string> = {
  open: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  partial: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
  settled: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  credit: "bg-[var(--color-primary-tint)] text-[var(--color-primary)]",
  void: "bg-[var(--color-surface-strong)] text-[var(--color-ink-faint)]",
};

const SETTLEMENT_INITIAL_FILTERS: FilterState = {
  state: { selected: ["open", "partial", "credit"] },
};

const SETTLEMENT_INITIAL_HIDDEN = ["personType", "personId", "transactions", "entries"];
const SETTLEMENT_SEARCH_KEYS = ["person", "personType", "item", "direction", "check", "date", "state"];

const SETTLEMENT_COLUMNS: ColumnDef<SettlementRow>[] = [
  { key: "person", label: "Person", kind: "text", frozen: true, width: 176, accessor: (row) => row.personName },
  { key: "personType", label: "Person type", kind: "badge", width: 112, accessor: (row) => row.personType },
  { key: "personId", label: "Person record", kind: "text", width: 280, accessor: (row) => row.personId },
  { key: "item", label: "Item", kind: "text", width: 176, accessor: (row) => row.label },
  {
    key: "direction",
    label: "Direction",
    kind: "badge",
    width: 128,
    accessor: (row) => row.direction,
    badgeLabels: { payable: "Agency pays", receivable: "Agency receives", reserve: "Set aside" },
  },
  { key: "check", label: "Check / period", kind: "text", width: 152, accessor: (row) => row.checkNumber ?? "Plan period" },
  { key: "date", label: "Date", kind: "date", width: 142, accessor: (row) => rowDate(row) },
  { key: "original", label: "Original", kind: "money", width: 112, align: "right", accessor: (row) => row.originalAmount },
  { key: "applied", label: "Applied", kind: "money", width: 112, align: "right", accessor: (row) => row.appliedAmount },
  { key: "balance", label: "Balance", kind: "money", width: 112, align: "right", accessor: (row) => row.balance },
  {
    key: "state",
    label: "State",
    kind: "badge",
    width: 104,
    accessor: (row) => row.state,
    badgeLabels: { open: "Open", partial: "Partial", settled: "Settled", credit: "Credit", void: "Void" },
  },
  { key: "lastAction", label: "Last action", kind: "date", width: 128, accessor: (row) => row.lastActionAt?.slice(0, 10) ?? null },
  { key: "transactions", label: "Transactions", kind: "int", width: 112, align: "right", accessor: (row) => String(row.transactionCount) },
  { key: "entries", label: "Entries", kind: "int", width: 88, align: "right", accessor: (row) => String(row.eventCount) },
];

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as ApiPayload<T>;
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error ?? `Request failed (${response.status}).`);
    }
    return payload.data as T;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Could not reach the server. Nothing was recorded.");
  }
}

function localToday(): string {
  const today = new Date();
  const year = String(today.getFullYear());
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}

function isActionable(row: SettlementRow): boolean {
  return row.state !== "void" && dec(row.balance).greaterThan(0);
}

function eventSearchText(event: SettlementEventRow): string {
  return [
    event.personName,
    event.eventType,
    event.obligationLabel,
    event.checkNumber,
    event.checkDate,
    event.periodBegin,
    event.periodEnd,
    event.occurredOn,
    event.reference,
    event.note,
    event.actorName,
  ].filter(Boolean).join(" ").toLowerCase();
}

function eventItemIdentity(event: Pick<
  SettlementEventRow,
  "checkNumber" | "checkDate" | "periodBegin" | "periodEnd"
>): string {
  const period = event.periodBegin && event.periodEnd
    ? `${formatDate(event.periodBegin)} to ${formatDate(event.periodEnd)}`
    : event.periodEnd
      ? `Through ${formatDate(event.periodEnd)}`
      : event.periodBegin
        ? `From ${formatDate(event.periodBegin)}`
        : event.checkDate
          ? formatDate(event.checkDate)
          : null;
  if (event.checkNumber) return `Check ${event.checkNumber}${period ? ` | ${period}` : ""}`;
  if (period) return period;
  return "Ledger item";
}

function rowDate(row: SettlementRow): string {
  return row.checkDate ?? row.periodEnd ?? row.periodBegin ?? row.createdAt.slice(0, 10);
}

function stateFilterMode(selected: string[] | undefined): StateFilter | null {
  if (selected === undefined) return "all";
  const ordered = [...selected].sort().join(",");
  if (ordered === "credit,open,partial") return "needs_action";
  if (selected.length === 1 && STATE_FILTERS.some((filter) => filter.value === selected[0])) {
    return selected[0] as StateFilter;
  }
  return null;
}

function metadataString(row: SettlementRow, key: string): string | null {
  const value = row.calculation[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function metadataBoolean(row: SettlementRow, key: string): boolean | null {
  const value = row.calculation[key];
  return typeof value === "boolean" ? value : null;
}

function safeMoney(value: string | null): string {
  if (value === null) return "-";
  try {
    return formatMoney(value);
  } catch {
    return "-";
  }
}

function safePercent(value: string | null): string {
  if (value === null) return "-";
  try {
    return `${dec(value).times(100).toDecimalPlaces(1).toString()}%`;
  } catch {
    return "-";
  }
}

function calculationReconciles(row: SettlementRow): boolean | null {
  const direct = metadataBoolean(row, "reconciles");
  if (direct !== null) return direct;
  const checks = row.calculation.reconciliations;
  if (!Array.isArray(checks) || checks.length === 0) return null;
  return checks.every((check) => (
    check !== null
    && typeof check === "object"
    && "reconciles" in check
    && check.reconciles === true
  ));
}

function parsePositiveAmount(value: string): Decimal | null {
  try {
    const amount = dec(value.trim()).toDecimalPlaces(4);
    return amount.greaterThan(0) ? amount : null;
  } catch {
    return null;
  }
}

function personHref(personType: SettlementRow["personType"], personId: string): string {
  return personType === "employee" ? `/employees/${personId}` : `/individuals/${personId}`;
}

function StateBadge({ state }: { state: SettlementRow["state"] }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLES[state]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {state === "credit" ? "Credit" : state.charAt(0).toUpperCase() + state.slice(1)}
    </span>
  );
}

function DirectionLabel({ row }: { row: SettlementRow }) {
  if (row.state === "credit") {
    const creditLabel = row.direction === "payable"
      ? "Agency credit"
      : row.direction === "receivable"
        ? "Employee credit"
        : "Reserve credit";
    return <span className="text-xs font-medium text-[var(--color-primary)]">{creditLabel}</span>;
  }
  const tone = row.direction === "payable"
    ? "text-[var(--color-danger)]"
    : row.direction === "receivable"
      ? "text-[var(--color-success)]"
      : "text-[var(--color-info)]";
  return <span className={`text-xs font-medium ${tone}`}>{row.directionLabel}</span>;
}

function DetailMetric({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.68rem] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</dt>
      <dd className={`tnum mt-0.5 truncate text-sm font-semibold ${muted ? "text-[var(--color-ink-soft)]" : "text-[var(--color-ink)]"}`} title={value}>{value}</dd>
    </div>
  );
}

function ReconciliationStatus({ row }: { row: SettlementRow }) {
  const reconciles = calculationReconciles(row);
  if (reconciles === null) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${reconciles ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {reconciles ? "Reconciles" : "Needs review"}
    </span>
  );
}

function DirectCalculationDetail({ row }: { row: SettlementRow }) {
  const rule = metadataString(row, "directRule") ?? "keep_all";
  const percent = metadataString(row, "directPercent");
  const ruleLabel = rule === "giveback_all"
    ? "Give back all check net"
    : rule === "giveback_percent"
      ? `Give back ${safePercent(percent)} of check net`
      : "Keep all check net";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-[var(--color-ink-soft)]">Direct employee check: {ruleLabel}</p>
        <ReconciliationStatus row={row} />
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-5">
        <DetailMetric label="Check gross" value={safeMoney(metadataString(row, "checkGross"))} />
        <DetailMetric label="Check net" value={safeMoney(metadataString(row, "checkNet"))} />
        <DetailMetric label="Employee keeps" value={safeMoney(metadataString(row, "employeeKeeps"))} />
        <DetailMetric label="Employee owes" value={safeMoney(metadataString(row, "employeeOwesAgency"))} />
        <DetailMetric label="Taxes (display only)" value={safeMoney(metadataString(row, "withholdingDisplayOnly"))} muted />
      </dl>
    </div>
  );
}

function AgencyCalculationDetail({ row }: { row: SettlementRow }) {
  const percent = metadataString(row, "agencyCutPercent");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-[var(--color-ink-soft)]">
          Agency-routed: base is split at {safePercent(percent)}; billed-minus-base spread stays outside the deal.
        </p>
        <ReconciliationStatus row={row} />
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-6">
        <DetailMetric label="Billed" value={safeMoney(metadataString(row, "billedAmount"))} />
        <DetailMetric label="Base" value={safeMoney(metadataString(row, "baseAmount"))} />
        <DetailMetric label="Agency spread" value={safeMoney(metadataString(row, "agencySpread"))} />
        <DetailMetric label="Agency cut" value={safeMoney(metadataString(row, "agencyCut"))} />
        <DetailMetric label="Employee payable" value={safeMoney(metadataString(row, "employeePayable"))} />
        <DetailMetric label="Agency keeps total" value={safeMoney(metadataString(row, "agencyKeepsTotal"))} />
      </dl>
    </div>
  );
}

function IndividualCalculationDetail({ row }: { row: SettlementRow }) {
  const formula = metadataString(row, "formula") ?? "Planned set-aside";
  const target = metadataString(row, "targetLabel") ?? row.label;
  const plannedHours = metadataString(row, "plannedHours");
  const actualHours = metadataString(row, "actualHours");
  const actualInternal = metadataString(row, "actualInternal");
  const utilization = metadataString(row, "utilizationPercent");
  const elapsed = metadataString(row, "timeElapsedPercent");
  const paceStatus = metadataString(row, "paceStatus");

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-[var(--color-ink)]">{target}</p>
          {paceStatus ? <span className="rounded-full bg-[var(--color-surface-strong)] px-2 py-0.5 text-xs font-medium capitalize text-[var(--color-ink-soft)]">{paceStatus.replaceAll("_", " ")}</span> : null}
        </div>
        <p className="text-xs text-[var(--color-ink-soft)]">{formula}</p>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4">
          <DetailMetric label="Target" value={formatMoney(row.originalAmount)} />
          <DetailMetric label="Monthly amount" value={safeMoney(metadataString(row, "monthlyAmount"))} />
          <DetailMetric label="Actual internal" value={safeMoney(actualInternal)} />
          <DetailMetric label="Actual / planned hours" value={`${actualHours ?? "-"} / ${plannedHours ?? "-"}`} />
        </dl>
      </div>
      <div className="self-center">
        {utilization !== null && elapsed !== null ? (
          <>
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
              <span>Actual {safePercent(utilization)}</span>
              <span>Time {safePercent(elapsed)}</span>
            </div>
            <PaceBar usagePercent={utilization} timeElapsedPercent={elapsed} />
          </>
        ) : (
          <p className="text-xs text-[var(--color-ink-faint)]">Pace is not available for this period.</p>
        )}
      </div>
    </div>
  );
}

function CalculationDetail({ row }: { row: SettlementRow }) {
  const flow = metadataString(row, "flow");
  const detail = flow === "direct_employee"
    ? <DirectCalculationDetail row={row} />
    : flow === "agency_routed"
      ? <AgencyCalculationDetail row={row} />
      : flow === "individual_plan"
        ? <IndividualCalculationDetail row={row} />
        : <p className="text-xs text-[var(--color-ink-faint)]">No calculation detail is available for this item.</p>;
  const adjustment = metadataString(row, "adjustmentAmount");
  const prior = metadataString(row, "priorOriginalAmount");
  const recalculated = metadataString(row, "recalculatedOriginalAmount");

  return (
    <div className="space-y-3">
      {adjustment !== null ? (
        <p className="border-l-2 border-[var(--color-info)] pl-3 text-xs text-[var(--color-ink-soft)]">
          Append-only recalculation: the target changed from {safeMoney(prior)} to {safeMoney(recalculated)}.
          This row records the signed difference of {safeMoney(adjustment)} without rewriting prior activity.
        </p>
      ) : null}
      {detail}
    </div>
  );
}

function SettlementCell({ row, column }: { row: SettlementRow; column: ColumnDef<SettlementRow> }) {
  switch (column.key) {
    case "person":
      return (
        <div>
          <Link href={personHref(row.personType, row.personId)} className="block truncate font-medium text-[var(--color-primary)] hover:underline" title={row.personName}>
            {row.personName}
          </Link>
          <span className="text-xs capitalize text-[var(--color-ink-faint)]">{row.personType}</span>
        </div>
      );
    case "personType":
      return <span className="capitalize">{row.personType}</span>;
    case "item":
      return (
        <div>
          <span className="block truncate font-medium" title={row.label}>{row.label}</span>
          <span className="text-xs text-[var(--color-ink-faint)]">{row.transactionCount} transaction{row.transactionCount === 1 ? "" : "s"}</span>
        </div>
      );
    case "direction":
      return <DirectionLabel row={row} />;
    case "check":
      return row.checkNumber ? <span className="block truncate font-medium">Check {row.checkNumber}</span> : <span className="text-[var(--color-ink-soft)]">Plan period</span>;
    case "date":
      return (
        <span className="block text-xs text-[var(--color-ink-soft)]">
          {row.checkDate
            ? formatDate(row.checkDate)
            : row.periodBegin || row.periodEnd
              ? `${formatDate(row.periodBegin)} - ${formatDate(row.periodEnd)}`
              : "No date"}
        </span>
      );
    case "original":
      return <>{formatMoney(row.originalAmount)}</>;
    case "applied":
      return <span className="text-[var(--color-ink-soft)]">{formatMoney(row.appliedAmount)}</span>;
    case "balance":
      return <span className={`font-semibold ${row.state === "credit" ? "text-[var(--color-primary)]" : ""}`}>{formatMoney(row.balance)}</span>;
    case "state":
      return (
        <div>
          <StateBadge state={row.state} />
          {row.voidReason ? <span className="mt-1 block truncate text-xs text-[var(--color-ink-faint)]" title={row.voidReason}>{row.voidReason}</span> : null}
        </div>
      );
    case "lastAction":
      return <span className="text-xs text-[var(--color-ink-soft)]">{row.lastActionAt ? formatDate(row.lastActionAt.slice(0, 10)) : "-"}</span>;
    case "transactions":
      return <>{row.transactionCount.toLocaleString()}</>;
    case "entries":
      return <>{row.eventCount.toLocaleString()}</>;
    default:
      return <>{column.accessor(row) ?? column.emptyText ?? ""}</>;
  }
}

function SummaryBand({ data }: { data: SettlementDashboardData }) {
  const needsAction = data.summary.openCount + data.summary.partialCount + data.summary.creditCount;
  const metrics = [
    { label: "Needs action", value: needsAction.toLocaleString(), hint: `${data.summary.partialCount} partial, ${data.summary.creditCount} credit` },
    { label: "Agency to pay", value: formatMoney(data.summary.agencyOwes), hint: "Employee payouts" },
    { label: "Agency to receive", value: formatMoney(data.summary.employeesOwe), hint: "Give-backs and fees" },
    { label: "Set aside", value: formatMoney(data.summary.reservesToSetAside), hint: "Individual reserves" },
    { label: "Credits", value: formatMoney(data.summary.credits), hint: "Paid above obligation" },
  ];

  return (
    <section aria-label="Settlement summary" className="grid overflow-hidden rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] grid-cols-2 md:grid-cols-5">
      {metrics.map((metric, index) => (
        <div
          key={metric.label}
          className={`min-w-0 px-3 py-3 ${index % 2 === 1 ? "border-l border-[var(--color-rule)]" : ""} ${index >= 2 ? "border-t border-[var(--color-rule)] md:border-t-0" : ""} ${index > 0 ? "md:border-l md:border-[var(--color-rule)]" : ""}`}
        >
          <p className="eyebrow truncate">{metric.label}</p>
          <p className="tnum mt-1 truncate text-lg font-semibold text-[var(--color-ink)]">{metric.value}</p>
          <p className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">{metric.hint}</p>
        </div>
      ))}
    </section>
  );
}

function MissingDeals({ data }: { data: SettlementDashboardData }) {
  if (data.missingDeals.length === 0) return null;
  return (
    <section className="border-l-4 border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3" aria-label="Employees missing a deal">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-[var(--color-warn)]">
          {data.missingDeals.length} employee{data.missingDeals.length === 1 ? " needs" : "s need"} a deal
        </h2>
        <p className="text-xs text-[var(--color-ink-soft)]">Their transactions cannot create settlement items yet.</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {data.missingDeals.map((employee) => (
          <Link key={employee.employeeId} href={`/employees/${employee.employeeId}`} className="font-medium text-[var(--color-primary)] hover:underline">
            {employee.employeeName} <span className="font-normal text-[var(--color-ink-faint)]">({employee.transactionCount})</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function checkIssueReference(issue: DirectCheckIssue): string {
  const parts: string[] = [];
  if (issue.checkNumber) parts.push(`Check ${issue.checkNumber}`);

  if (issue.periodBegin && issue.periodEnd) {
    parts.push(`Pay period ${formatDate(issue.periodBegin)} to ${formatDate(issue.periodEnd)}`);
  } else if (issue.periodBegin || issue.periodEnd) {
    parts.push(`Pay period ${formatDate(issue.periodBegin ?? issue.periodEnd)}`);
  } else if (issue.checkDate) {
    parts.push(`Dated ${formatDate(issue.checkDate)}`);
  }

  return parts.join(" | ") || "Payroll transaction";
}

const CHECK_ISSUE_COPY: Record<DirectCheckIssue["issue"], { label: string; guidance: string }> = {
  missing_check_identity: {
    label: "Missing check identity",
    guidance: "Add a check number, check date, or pay period so this payment can be identified once.",
  },
  missing_net: {
    label: "Missing net",
    guidance: "Enter the whole-check net pay.",
  },
  conflicting_net: {
    label: "Conflicting net",
    guidance: "Use one whole-check net value across these transactions.",
  },
  conflicting_check_date: {
    label: "Conflicting dates",
    guidance: "Use one check date for this check number.",
  },
  missing_base: {
    label: "Missing base",
    guidance: "Enter the employee base amount before calculating an agency-routed payout.",
  },
  unknown_recipient: {
    label: "Recipient needed",
    guidance: "Choose whether the employee or the agency received this payment.",
  },
};

function CheckIssues({ data }: { data: SettlementDashboardData }) {
  if (data.checkIssues.length === 0) return null;

  const counts = new Map<DirectCheckIssue["issue"], number>();
  for (const issue of data.checkIssues) counts.set(issue.issue, (counts.get(issue.issue) ?? 0) + 1);

  return (
    <section aria-labelledby="direct-check-issues-title">
      <details className="group border-l-4 border-[var(--color-warn)] bg-[var(--color-warn-soft)]">
        <summary className="cursor-pointer px-4 py-3 marker:text-[var(--color-warn)]">
          <span className="ml-1 inline-flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span id="direct-check-issues-title" className="text-sm font-semibold text-[var(--color-warn)]">
              {data.checkIssues.length} payroll source{data.checkIssues.length === 1 ? " needs" : "s need"} attention
            </span>
            <span className="text-xs text-[var(--color-ink-soft)]">
              {[...counts.entries()].map(([issue, count]) => `${count} ${CHECK_ISSUE_COPY[issue].label.toLowerCase()}`).join("; ")}
            </span>
          </span>
        </summary>

        <div className="border-t border-[var(--color-rule)] px-4 pb-3 pt-2">
          <p id="direct-check-issues-help" className="text-xs leading-5 text-[var(--color-ink-soft)]">
            Direct give-backs use one whole-check net; agency-routed payouts use the recorded base amount. Correct these source fields, then refresh settlements.
          </p>
          <ul aria-describedby="direct-check-issues-help" className="mt-2 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
            {data.checkIssues.map((issue) => {
              const copy = CHECK_ISSUE_COPY[issue.issue];
              return (
                <li key={`${issue.sourceId}:${issue.issue}`} className="grid gap-1 py-2 text-sm sm:grid-cols-[minmax(12rem,1fr)_minmax(16rem,1.5fr)] sm:gap-4">
                  <div className="min-w-0">
                    <Link href={`/employees/${issue.employeeId}`} className="font-medium text-[var(--color-primary)] hover:underline">
                      {issue.employeeName}
                    </Link>
                    <p className="truncate text-xs text-[var(--color-ink-faint)]" title={checkIssueReference(issue)}>
                      {checkIssueReference(issue)}
                      {issue.transactionCount > 1 ? ` | ${issue.transactionCount} transactions` : ""}
                    </p>
                  </div>
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-[var(--color-warn)] ring-1 ring-inset ring-[var(--color-warn)]">
                      {copy.label}
                    </span>
                    <span className="text-xs leading-5 text-[var(--color-ink-soft)]">
                      {copy.guidance}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
    </section>
  );
}

function ItemsTable({
  grid,
  rows,
  canManage,
  selected,
  expanded,
  onToggle,
  onToggleAll,
  onToggleExpanded,
  onRecord,
  onUseCredit,
  creditTargetsFor,
}: {
  grid: UseGridResult<SettlementRow, unknown>;
  rows: SettlementRow[];
  canManage: boolean;
  selected: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onToggleExpanded: (id: string) => void;
  onRecord: (row: SettlementRow) => void;
  onUseCredit: (row: SettlementRow) => void;
  creditTargetsFor: (row: SettlementRow) => SettlementRow[];
}) {
  const actionable = canManage ? rows.filter(isActionable) : [];
  const allSelected = actionable.length > 0 && actionable.every((row) => selected.has(row.id));
  const utilityWidth = 36 + (canManage ? 40 + 128 : 0);
  const utilityColumns = 1 + (canManage ? 2 : 0);
  const tableWidth = utilityWidth + grid.visibleColumns.reduce((total, column) => total + (column.width ?? 120), 0);

  return (
    <div className="scroll-thin relative max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
      <table className="table-fixed border-collapse text-sm" style={{ width: tableWidth }}>
        <caption className="sr-only">Settlement obligations and current balances</caption>
        <colgroup>
          {canManage ? <col style={{ width: 40 }} /> : null}
          <col style={{ width: 36 }} />
          {grid.visibleColumns.map((column) => <col key={column.key} style={{ width: column.width ?? 120 }} />)}
          {canManage ? <col style={{ width: 128 }} /> : null}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-[var(--color-surface-strong)] text-left">
          <tr className="border-b border-[var(--color-rule-strong)]">
            {canManage ? <th className="px-3 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={actionable.length === 0}
                onChange={onToggleAll}
                aria-label="Select all visible unsettled items"
              />
            </th> : null}
            <th className="px-1 py-2"><span className="sr-only">Calculation detail</span></th>
            {grid.visibleColumns.map((column) => {
              const sort = grid.sort.find((item) => item.key === column.key);
              const numeric = isNumericKind(column.kind) || column.align === "right";
              return (
                <th
                  key={column.key}
                  aria-sort={sort ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={`px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)] ${numeric ? "text-right" : "text-left"}`}
                >
                  <div className={`flex items-center gap-1 ${numeric ? "flex-row-reverse" : ""}`}>
                    <span className="min-w-0 flex-1 truncate">{column.label}</span>
                    <SortMenu label={column.label} numeric={numeric} dir={sort?.dir ?? null} onSort={(direction) => grid.sortColumn(column.key, direction)} />
                    <HeaderFilter grid={grid} col={column} />
                  </div>
                </th>
              );
            })}
            {canManage ? <th className="px-3 py-2"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const canSettle = isActionable(row);
            const checked = canSettle && selected.has(row.id);
            const open = expanded.has(row.id);
            const hasCalculation = Object.keys(row.calculation).length > 0;
            return (
              <Fragment key={row.id}>
                <tr className={`border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)] ${checked ? "bg-[var(--color-primary-tint)]" : ""}`}>
                  {canManage ? <td className="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canSettle}
                      onChange={() => onToggle(row.id)}
                      aria-label={`Select ${row.label} for ${row.personName}`}
                    />
                  </td> : null}
                  <td className="px-1 py-2 align-top">
                    <button
                      type="button"
                      disabled={!hasCalculation}
                      onClick={() => onToggleExpanded(row.id)}
                      className="grid h-6 w-6 place-items-center rounded text-sm text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)] disabled:opacity-30"
                      aria-expanded={open}
                      aria-label={`${open ? "Hide" : "Show"} calculation for ${row.personName}`}
                      title={`${open ? "Hide" : "Show"} calculation`}
                    >
                      <span aria-hidden>{open ? "▾" : "▸"}</span>
                    </button>
                  </td>
                  {grid.visibleColumns.map((column) => {
                    const numeric = isNumericKind(column.kind) || column.align === "right";
                    return (
                      <td key={column.key} className={`overflow-hidden px-3 py-2 align-top ${numeric ? "tnum text-right" : "text-left"}`}>
                        <SettlementCell row={row} column={column} />
                      </td>
                    );
                  })}
                  {canManage ? <td className="px-3 py-2 text-right align-top">
                    {row.state === "credit" ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        disabled={creditTargetsFor(row).length === 0}
                        onClick={() => onUseCredit(row)}
                        title={creditTargetsFor(row).length === 0 ? "No compatible open balance yet" : undefined}
                      >
                        Use credit
                      </button>
                    ) : row.state !== "void" ? (
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => onRecord(row)}>
                        Record amount
                      </button>
                    ) : null}
                  </td> : null}
                </tr>
                {open ? (
                  <tr className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)]">
                    <td colSpan={grid.visibleColumns.length + utilityColumns} className="px-5 py-3">
                      <CalculationDetail row={row} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={grid.visibleColumns.length + utilityColumns} className="px-4 py-12 text-center text-sm text-[var(--color-ink-faint)]">No settlement items match these filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({
  events,
  canManage,
  onReverse,
}: {
  events: SettlementEventRow[];
  canManage: boolean;
  onReverse: (event: SettlementEventRow) => void;
}) {
  const columnCount = canManage ? 9 : 8;
  return (
    <div className="scroll-thin relative max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
      <table className={`w-full ${canManage ? "min-w-[1216px]" : "min-w-[1120px]"} table-fixed border-collapse text-sm`}>
        <caption className="sr-only">Recent settlement payment and reversal history</caption>
        <colgroup>
          <col className="w-32" />
          <col className="w-44" />
          <col className="w-44" />
          <col className="w-28" />
          <col className="w-28" />
          <col className="w-44" />
          <col className="w-56" />
          <col className="w-36" />
          {canManage ? <col className="w-24" /> : null}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-[var(--color-surface-strong)] text-left">
          <tr className="border-b border-[var(--color-rule-strong)]">
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Entry</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Person</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Item</th>
            <th className="px-3 py-2 text-right text-xs font-semibold text-[var(--color-ink-faint)]">Amount</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Occurred</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Reference</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Note</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Recorded by</th>
            {canManage ? <th className="px-3 py-2"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const reversed = event.reversedByEventId !== null;
            const isReversal = event.eventType === "reversal";
            return (
              <tr key={event.id} className="border-b border-[var(--color-rule)] last:border-0 hover:bg-[var(--color-surface-muted)]">
                <td className="px-3 py-2 align-top">
                  <span className={`font-medium ${isReversal ? "text-[var(--color-danger)]" : ""}`}>
                    {isReversal
                      ? "Reversal"
                      : event.eventType === "set_aside"
                        ? "Set aside"
                        : event.eventType === "credit"
                          ? dec(event.amount).isNegative() ? "Credit used" : "Credit applied"
                          : "Payment"}
                  </span>
                  {reversed ? <span className="mt-1 block text-xs font-medium text-[var(--color-danger)]">Reversed</span> : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <Link href={personHref(event.personType, event.personId)} className="block truncate font-medium text-[var(--color-primary)] hover:underline" title={event.personName}>
                    {event.personName}
                  </Link>
                  <span className="text-xs capitalize text-[var(--color-ink-faint)]">{event.personType}</span>
                </td>
                <td className="px-3 py-2 align-top">
                  <span className="block truncate font-medium" title={event.obligationLabel ?? undefined}>{event.obligationLabel ?? "Ledger item"}</span>
                  <span className="block truncate text-xs text-[var(--color-ink-faint)]" title={eventItemIdentity(event)}>{eventItemIdentity(event)}</span>
                </td>
                <td className={`tnum px-3 py-2 text-right align-top font-semibold ${isReversal ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(event.amount)}</td>
                <td className="px-3 py-2 align-top text-xs">{formatDate(event.occurredOn)}</td>
                <td className="px-3 py-2 align-top text-xs text-[var(--color-ink-soft)]">
                  <span className="block truncate" title={event.reference ?? undefined}>{event.reference ?? "-"}</span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-[var(--color-ink-soft)]">
                  <span className="line-clamp-2 whitespace-pre-wrap" title={event.note ?? undefined}>{event.note ?? "-"}</span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-[var(--color-ink-soft)]">
                  <span className="block truncate" title={event.actorName ?? "System"}>{event.actorName ?? "System"}</span>
                  <span className="text-[var(--color-ink-faint)]">{formatDate(event.createdAt.slice(0, 10))}</span>
                </td>
                {canManage ? <td className="px-3 py-2 text-right align-top">
                  {!isReversal && !reversed ? (
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => onReverse(event)}>Reverse</button>
                  ) : null}
                </td> : null}
              </tr>
            );
          })}
          {events.length === 0 ? (
            <tr><td colSpan={columnCount} className="px-4 py-12 text-center text-sm text-[var(--color-ink-faint)]">No history matches this search.</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function SettleModal({ rows, onClose, onDone }: { rows: SettlementRow[]; onClose: () => void; onDone: (message: string) => void }) {
  const [operationKey] = useState(() => crypto.randomUUID());
  const [occurredOn, setOccurredOn] = useState(localToday);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => rows.reduce(
    (current, row) => ({ ...current, [row.direction]: current[row.direction].plus(row.balance) }),
    { payable: dec(0), receivable: dec(0), reserve: dec(0) },
  ), [rows]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/settlements/events", {
        action: "settle",
        obligationIds: rows.map((row) => row.id),
        occurredOn,
        operationKey,
        reference,
        note,
      });
      onDone(`Marked ${rows.length} settlement item${rows.length === 1 ? "" : "s"} settled.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The settlements could not be recorded.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Mark exact balances settled" onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">
          This records each of the {rows.length} selected remaining balances separately.
        </p>
        <dl className="grid grid-cols-1 gap-2 border-y border-[var(--color-rule)] py-3 sm:grid-cols-3">
          <div><dt className="text-xs text-[var(--color-ink-faint)]">Agency pays</dt><dd className="tnum font-semibold">{formatMoney(totals.payable)}</dd></div>
          <div><dt className="text-xs text-[var(--color-ink-faint)]">Agency receives</dt><dd className="tnum font-semibold">{formatMoney(totals.receivable)}</dd></div>
          <div><dt className="text-xs text-[var(--color-ink-faint)]">Set aside</dt><dd className="tnum font-semibold">{formatMoney(totals.reserve)}</dd></div>
        </dl>
        <label className="block text-sm font-medium">
          Settlement date
          <input type="date" required value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} className="input mt-1 w-full" placeholder="Check, transfer, or batch reference" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || rows.length === 0 || !occurredOn} className="btn btn-sm btn-primary">
            {busy ? "Recording..." : `Mark ${rows.length} settled`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PaymentModal({ row, onClose, onDone }: { row: SettlementRow; onClose: () => void; onDone: (message: string) => void }) {
  const [operationKey] = useState(() => crypto.randomUUID());
  const startingAmount = dec(row.balance).greaterThan(0) ? dec(row.balance).toString() : "";
  const [amount, setAmount] = useState(startingAmount);
  const [occurredOn, setOccurredOn] = useState(localToday);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedAmount = parsePositiveAmount(amount);
  const nextBalance = parsedAmount ? dec(row.balance).minus(parsedAmount) : null;
  const amountLabel = row.direction === "reserve" ? "Amount set aside" : row.direction === "receivable" ? "Amount received" : "Amount paid";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parsedAmount) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/settlements/events", {
        action: "payment",
        obligationId: row.id,
        amount: amount.trim(),
        occurredOn,
        operationKey,
        reference,
        note,
      });
      onDone(`Recorded ${formatMoney(parsedAmount)} for ${row.personName}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The amount could not be recorded.");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Record amount - ${row.personName}`} onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <div>
          <p className="text-sm font-medium">{row.label}</p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
            <span>Original <strong className="tnum text-[var(--color-ink)]">{formatMoney(row.originalAmount)}</strong></span>
            <span>Applied <strong className="tnum text-[var(--color-ink)]">{formatMoney(row.appliedAmount)}</strong></span>
            <span>Balance <strong className="tnum text-[var(--color-ink)]">{formatMoney(row.balance)}</strong></span>
          </div>
        </div>
        <label className="block text-sm font-medium">
          {amountLabel}
          <input
            autoFocus
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input tnum mt-1 w-full"
            placeholder="0.00"
            aria-describedby="payment-balance-preview"
          />
        </label>
        <p id="payment-balance-preview" className={`text-sm ${nextBalance?.isNegative() ? "font-medium text-[var(--color-primary)]" : "text-[var(--color-ink-soft)]"}`}>
          {!nextBalance
            ? "Enter the amount that actually moved."
            : nextBalance.isNegative()
              ? `This creates a credit of ${formatMoney(nextBalance.abs())}.`
              : nextBalance.isZero()
                ? "This settles the balance exactly."
                : `${formatMoney(nextBalance)} will remain.`}
        </p>
        <label className="block text-sm font-medium">
          Date
          <input type="date" required value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} className="input mt-1 w-full" placeholder="Check or transfer reference" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !parsedAmount || !occurredOn} className="btn btn-sm btn-primary">
            {busy ? "Recording..." : "Record amount"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreditModal({
  source,
  targets,
  onClose,
  onDone,
}: {
  source: SettlementRow;
  targets: SettlementRow[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const initialTarget = targets[0];
  const creditAvailable = dec(source.balance).abs();
  const initialAmount = initialTarget
    ? (creditAvailable.lessThan(dec(initialTarget.balance)) ? creditAvailable : dec(initialTarget.balance)).toString()
    : "";
  const [operationKey] = useState(() => crypto.randomUUID());
  const [targetId, setTargetId] = useState(initialTarget?.id ?? "");
  const [amount, setAmount] = useState(initialAmount);
  const [occurredOn, setOccurredOn] = useState(localToday);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((row) => row.id === targetId) ?? null;
  const parsedAmount = parsePositiveAmount(amount);
  const maximum = target
    ? (creditAvailable.lessThan(dec(target.balance)) ? creditAvailable : dec(target.balance))
    : dec(0);
  const validAmount = parsedAmount !== null && parsedAmount.lessThanOrEqualTo(maximum);

  const chooseTarget = (id: string) => {
    setTargetId(id);
    const next = targets.find((row) => row.id === id);
    if (next) {
      const nextMaximum = creditAvailable.lessThan(dec(next.balance)) ? creditAvailable : dec(next.balance);
      setAmount(nextMaximum.toString());
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || !parsedAmount || !validAmount) {
      setError(`Enter an amount no greater than ${formatMoney(maximum)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/settlements/events", {
        action: "apply_credit",
        sourceObligationId: source.id,
        targetObligationId: target.id,
        amount: parsedAmount.toString(),
        occurredOn,
        operationKey,
        reference,
        note,
      });
      onDone(`Applied ${formatMoney(parsedAmount)} of credit for ${source.personName}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The credit could not be applied.");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Use credit - ${source.personName}`} onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">
          Available credit <strong className="tnum text-[var(--color-ink)]">{formatMoney(creditAvailable)}</strong>
        </p>
        <label className="block text-sm font-medium">
          Apply to
          <select required value={targetId} onChange={(event) => chooseTarget(event.target.value)} className="input mt-1 w-full">
            {targets.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label} | {formatDate(rowDate(row))} | {formatMoney(row.balance)} remaining
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Credit amount
          <input
            autoFocus
            required
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input tnum mt-1 w-full"
            aria-describedby="credit-amount-limit"
          />
        </label>
        <p id="credit-amount-limit" className="text-xs text-[var(--color-ink-soft)]">
          Up to {formatMoney(maximum)} can be applied to this balance.
        </p>
        <label className="block text-sm font-medium">
          Date
          <input type="date" required value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} className="input mt-1 w-full" placeholder="Check or transfer reference" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !target || !validAmount || !occurredOn} className="btn btn-sm btn-primary">
            {busy ? "Applying..." : "Apply credit"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReverseModal({ event, onClose, onDone }: { event: SettlementEventRow; onClose: () => void; onDone: (message: string) => void }) {
  const [operationKey] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reversesCreditPair = event.batchAction === "apply_credit" && event.pairedObligationId !== null;

  const submit = async (formEvent: React.FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!reason.trim()) {
      setError("Enter a reason for the reversal.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/settlements/events/${encodeURIComponent(event.id)}/reverse`, { reason, operationKey });
      onDone(reversesCreditPair
        ? `Reversed both sides of the ${formatMoney(dec(event.amount).abs())} credit transfer for ${event.personName}.`
        : `Reversed the ${formatMoney(event.amount)} entry for ${event.personName}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The entry could not be reversed.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Reverse settlement entry" onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">
          Reverse <strong className="tnum text-[var(--color-ink)]">{formatMoney(reversesCreditPair ? dec(event.amount).abs() : event.amount)}</strong> for <strong className="text-[var(--color-ink)]">{event.personName}</strong> from {formatDate(event.occurredOn)}.
        </p>
        {reversesCreditPair ? (
          <p className="rounded border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-ink)]">
            This reverses both sides of the credit transfer: {event.obligationLabel ?? "this ledger item"} ({eventItemIdentity(event)}) and {event.pairedObligationLabel ?? "the paired ledger item"} ({eventItemIdentity({
              checkNumber: event.pairedCheckNumber,
              checkDate: event.pairedCheckDate,
              periodBegin: event.pairedPeriodBegin,
              periodEnd: event.pairedPeriodEnd,
            })}).
          </p>
        ) : null}
        <label className="block text-sm font-medium">
          Reason
          <textarea autoFocus required value={reason} onChange={(changeEvent) => setReason(changeEvent.target.value)} rows={3} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !reason.trim()} className="btn btn-sm btn-danger">
            {busy ? "Reversing..." : "Reverse entry"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function SettlementDashboard({
  data,
  canManage,
  initialPersonName,
  initialPersonId,
  initialPersonType,
}: {
  data: SettlementDashboardData;
  canManage: boolean;
  initialPersonName?: string | null;
  initialPersonId?: string | null;
  initialPersonType?: SettlementRow["personType"] | null;
}) {
  const router = useRouter();
  const initialFilters = useMemo<FilterState>(
    () => {
      if (!initialPersonId || !initialPersonType) return SETTLEMENT_INITIAL_FILTERS;
      return {
        ...(initialPersonName ? { person: { selected: [initialPersonName] } } : {}),
        personId: { selected: [initialPersonId] },
        personType: { selected: [initialPersonType] },
      };
    },
    [initialPersonId, initialPersonName, initialPersonType],
  );
  const grid = useGrid<SettlementRow>({
    rows: data.rows,
    columns: SETTLEMENT_COLUMNS,
    gridKey: "settlements",
    canManage,
    initialFilters,
    initialHidden: SETTLEMENT_INITIAL_HIDDEN,
    searchKeys: SETTLEMENT_SEARCH_KEYS,
    serializeHidden: true,
  });
  const [view, setView] = useState<View>("items");
  const [historySearch, setHistorySearch] = useState("");
  const deferredHistorySearch = useDeferredValue(historySearch);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [settleOpen, setSettleOpen] = useState(false);
  const [paymentRow, setPaymentRow] = useState<SettlementRow | null>(null);
  const [creditRow, setCreditRow] = useState<SettlementRow | null>(null);
  const [reverseEvent, setReverseEvent] = useState<SettlementEventRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const canRecord = canManage && !data.freshness.dirty;

  const historyNeedle = deferredHistorySearch.trim().toLowerCase();
  const historyPersonIds = grid.filters.personId?.selected;
  const historyPersonTypes = grid.filters.personType?.selected;
  const filteredEvents = useMemo(
    () => data.events.filter((event) => (
      (!historyPersonIds?.length || historyPersonIds.includes(event.personId))
      && (!historyPersonTypes?.length || historyPersonTypes.includes(event.personType))
      && (!historyNeedle || eventSearchText(event).includes(historyNeedle))
    )),
    [data.events, historyNeedle, historyPersonIds, historyPersonTypes],
  );

  const selectedRows = useMemo(
    () => canRecord ? grid.filtered.filter((row) => selected.has(row.id) && isActionable(row)) : [],
    [canRecord, grid.filtered, selected],
  );

  const creditTargetsFor = (source: SettlementRow) => data.rows.filter((row) => (
    row.id !== source.id
    && row.personType === source.personType
    && row.personId === source.personId
    && row.direction === source.direction
    && row.state !== "void"
    && dec(row.balance).greaterThan(0)
  ));

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const ids = grid.sorted.filter(isActionable).map((row) => row.id);
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeStateFilter = stateFilterMode(grid.filters.state?.selected);
  const applyStateFilter = (filter: StateFilter) => {
    if (filter === "all") {
      grid.setFilter("state", null);
    } else if (filter === "needs_action") {
      grid.setFilter("state", { selected: ["open", "partial", "credit"] });
    } else {
      grid.setFilter("state", { selected: [filter] });
    }
  };

  const completeAction = (message: string) => {
    setNotice({ tone: "success", message });
    setSelected(new Set());
    setSettleOpen(false);
    setPaymentRow(null);
    setCreditRow(null);
    setReverseEvent(null);
    router.refresh();
  };

  const refresh = async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      const result = await postJson<RefreshResult>("/api/settlements/refresh", {});
      const changed = result.created + result.updated + result.adjusted + result.voided;
      const blocked = result.skippedMissingCheckIdentity
        + result.skippedMissingNet
        + result.skippedInconsistentNet
        + result.skippedInconsistentCheck
        + result.skippedMissingBase
        + result.skippedUnknownRecipient;
      setNotice({
        tone: blocked > 0 ? "error" : "success",
        message: blocked > 0
          ? `${blocked} payroll source${blocked === 1 ? " needs" : "s need"} correction before a settlement can be calculated. Open the attention list above.`
          : changed > 0
          ? `Settlement items refreshed: ${result.created} new, ${result.updated} updated, ${result.adjusted} adjusted, ${result.voided} voided.`
          : "Settlement items are up to date.",
      });
      setSelected(new Set());
      router.refresh();
    } catch (refreshError) {
      setNotice({ tone: "error", message: refreshError instanceof Error ? refreshError.message : "Settlement items could not be refreshed." });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      <SummaryBand data={data} />
      {canManage ? <MissingDeals data={data} /> : null}
      {canManage ? <CheckIssues data={data} /> : null}

      {data.freshness.dirty ? (
        <div role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          <p className="font-medium">Refresh required before recording settlement activity.</p>
          <p className="mt-0.5">Payroll, deal, plan, or rate information changed after these balances were calculated. Payments, credits, and reversals are temporarily blocked.</p>
          {data.freshness.lastRefreshError ? <p className="mt-0.5">{data.freshness.lastRefreshError}</p> : null}
        </div>
      ) : null}

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={`rounded border px-3 py-2 text-sm ${notice.tone === "error" ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]" : "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"}`}>
          {notice.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule-strong)]">
        <div role="tablist" aria-label="Settlement views" className="flex gap-1">
          <button id="settlement-items-tab" type="button" role="tab" aria-selected={view === "items"} aria-controls="settlement-items-panel" onClick={() => setView("items")} className={`border-b-2 px-3 py-2 text-sm font-medium ${view === "items" ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
            Items <span className="tnum text-xs text-[var(--color-ink-faint)]">{grid.filtered.length}</span>
          </button>
          <button id="settlement-history-tab" type="button" role="tab" aria-selected={view === "history"} aria-controls="settlement-history-panel" onClick={() => setView("history")} className={`border-b-2 px-3 py-2 text-sm font-medium ${view === "history" ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
            History <span className="tnum text-xs text-[var(--color-ink-faint)]">{filteredEvents.length}</span>
          </button>
        </div>
        {canManage ? <button type="button" disabled={refreshing} onClick={refresh} className="btn btn-sm btn-secondary mb-1">
          {refreshing ? "Refreshing..." : "Refresh items"}
        </button> : null}
      </div>

      <section id={view === "items" ? "settlement-items-panel" : "settlement-history-panel"} role="tabpanel" aria-labelledby={view === "items" ? "settlement-items-tab" : "settlement-history-tab"} className="space-y-3">
        {view === "items" ? (
          <>
            <Toolbar
              grid={grid}
              searchPlaceholder="Search person, item, check, or date"
              exportEndpoint="/api/grid/export"
              exportTitle="Settlement obligations"
              exportFilename="settlements"
              extraActions={canManage ? (
                <>
                  {selectedRows.length > 0 ? <span className="tnum text-xs font-medium text-[var(--color-primary)]">{selectedRows.length} selected</span> : null}
                  <button type="button" disabled={!canRecord || selectedRows.length === 0} onClick={() => setSettleOpen(true)} className="btn btn-sm btn-primary">
                    Mark selected settled
                  </button>
                </>
              ) : undefined}
            />
            <FilterBar grid={grid} />
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-1" aria-label="Filter by settlement state">
                {STATE_FILTERS.map((filter) => (
                  <button key={filter.value} type="button" onClick={() => applyStateFilter(filter.value)} aria-pressed={activeStateFilter === filter.value} className={`rounded px-2 py-1 text-xs font-medium ${activeStateFilter === filter.value ? "bg-[var(--color-surface)] text-[var(--color-primary)] shadow-sm" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <ItemsTable
              grid={grid}
              rows={grid.sorted}
              canManage={canRecord}
              selected={selected}
              expanded={expanded}
              onToggle={toggleSelected}
              onToggleAll={toggleAllVisible}
              onToggleExpanded={toggleExpanded}
              onRecord={setPaymentRow}
              onUseCredit={setCreditRow}
              creditTargetsFor={creditTargetsFor}
            />
          </>
        ) : (
          <>
            <label className="block max-w-xl">
              <span className="sr-only">Search settlement history</span>
              <input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} className="input w-full" placeholder="Search person, reference, note, or actor" />
            </label>
            <HistoryTable events={filteredEvents} canManage={canRecord} onReverse={setReverseEvent} />
          </>
        )}
      </section>

      {canRecord && settleOpen && selectedRows.length > 0 ? <SettleModal rows={selectedRows} onClose={() => setSettleOpen(false)} onDone={completeAction} /> : null}
      {canRecord && paymentRow ? <PaymentModal row={paymentRow} onClose={() => setPaymentRow(null)} onDone={completeAction} /> : null}
      {canRecord && creditRow ? <CreditModal source={creditRow} targets={creditTargetsFor(creditRow)} onClose={() => setCreditRow(null)} onDone={completeAction} /> : null}
      {canRecord && reverseEvent ? <ReverseModal event={reverseEvent} onClose={() => setReverseEvent(null)} onDone={completeAction} /> : null}
    </div>
  );
}

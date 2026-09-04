"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, BadgeCheck, ChevronLeft, ChevronRight, CreditCard, PiggyBank } from "lucide-react";
import { FilterBar, HeaderFilter } from "@/components/data-grid/filter-bar";
import SortMenu from "@/components/data-grid/sort-menu";
import { Toolbar } from "@/components/data-grid/toolbar";
import { isNumericKind, type ColumnDef, type FilterState } from "@/components/data-grid/types";
import { useGrid, type UseGridResult } from "@/components/data-grid/use-grid";
import {
  settlementFocusFromParam,
  settlementMissingDealsState,
  settlementQueueFilters,
  settlementQueueFromParam,
  type SettlementQueueFilter,
} from "@/components/settlements/deep-links";
import { CheckIssues } from "@/components/settlements/settlement-check-issues";
import { CreditModal, HistoryTable, PaymentModal, ReverseModal, SettleModal } from "@/components/settlements/settlement-history-actions";
import { EmptyState, PaceBar } from "@/components/ui";
import type {
  SettlementDashboardData,
  SettlementEventRow,
  SettlementRow,
} from "@/lib/data/settlements";
import { dec, formatMoney } from "@/lib/money";

type View = "items" | "history";
type QueueFilter = SettlementQueueFilter;
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

const STATE_STYLES: Record<SettlementRow["state"], string> = {
  open: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  partial: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
  settled: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  credit: "bg-[var(--color-primary-tint)] text-[var(--color-primary)]",
  void: "bg-[var(--color-surface-strong)] text-[var(--color-ink-faint)]",
};

const SETTLEMENT_INITIAL_HIDDEN = ["personType", "personId", "transactions", "entries"];
const SETTLEMENT_SEARCH_KEYS = ["person", "personType", "item", "direction", "check", "date", "state"];
const HISTORY_PAGE_SIZE = 50;

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

function rowDate(row: SettlementRow): string {
  return row.checkDate ?? row.periodEnd ?? row.periodBegin ?? row.createdAt.slice(0, 10);
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
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-6">
        <DetailMetric label="Check gross" value={safeMoney(metadataString(row, "checkGross"))} />
        <DetailMetric label="Check net" value={safeMoney(metadataString(row, "checkNet"))} />
        <DetailMetric label="Employee keeps" value={safeMoney(metadataString(row, "employeeKeeps"))} />
        <DetailMetric label="Employee owes" value={safeMoney(metadataString(row, "employeeOwesAgency"))} />
        <DetailMetric label="Tax withheld (display only)" value={safeMoney(metadataString(row, "taxWithheldDisplayOnly"))} muted />
        <DetailMetric label="Total deductions" value={safeMoney(metadataString(row, "totalDeductionsDisplayOnly"))} muted />
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

function useDeepLinkTarget<Element extends HTMLElement>(active: boolean) {
  const ref = useRef<Element>(null);

  useEffect(() => {
    if (!active || !ref.current) return;
    const target = ref.current;
    const frame = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  return ref;
}

function deepLinkTargetClass(active: boolean): string {
  return active
    ? "scroll-mt-24 outline outline-2 outline-offset-2 outline-[var(--color-primary)]"
    : "scroll-mt-24";
}

function SummaryBand({
  data,
  active,
  onSelect,
}: {
  data: SettlementDashboardData;
  active: QueueFilter | null;
  onSelect: (queue: QueueFilter) => void;
}) {
  const actionableCredits = data.rows.filter((source) => (
    source.state === "credit"
    && data.rows.some((target) => (
      target.id !== source.id
      && target.personType === source.personType
      && target.personId === source.personId
      && target.direction === source.direction
      && target.state !== "void"
      && dec(target.balance).greaterThan(0)
    ))
  )).length;
  const needsAction = data.summary.openCount + data.summary.partialCount + actionableCredits;
  const metrics = [
    { queue: "open" as const, label: "Open work", value: needsAction.toLocaleString(), hint: `${data.summary.partialCount} partially completed`, icon: <CreditCard className="h-4 w-4" aria-hidden /> },
    { queue: "payable" as const, label: "Agency pays", value: formatMoney(data.summary.agencyOwes), hint: "Employee payments", icon: <ArrowUpRight className="h-4 w-4" aria-hidden /> },
    { queue: "receivable" as const, label: "Agency receives", value: formatMoney(data.summary.employeesOwe), hint: "Employee give-backs", icon: <ArrowDownLeft className="h-4 w-4" aria-hidden /> },
    { queue: "reserve" as const, label: "Set aside", value: formatMoney(data.summary.reservesToSetAside), hint: "Individual annual reserves", icon: <PiggyBank className="h-4 w-4" aria-hidden /> },
    { queue: "credit" as const, label: "Credits", value: formatMoney(data.summary.credits), hint: `${actionableCredits} ready to apply`, icon: <BadgeCheck className="h-4 w-4" aria-hidden /> },
  ];

  return (
    <section id="settlement-queues" aria-label="Payment work queues" className="grid scroll-mt-24 border-y border-[var(--color-rule)] grid-cols-2 md:grid-cols-5">
      {metrics.map((metric) => (
        <button
          key={metric.label}
          type="button"
          onClick={() => onSelect(metric.queue)}
          aria-pressed={active === metric.queue}
          className={`min-w-0 border-b border-r border-[var(--color-rule)] px-4 py-3 text-left transition-colors last:border-r-0 md:border-b-0 ${active === metric.queue ? "bg-[var(--color-primary-tint)]" : "hover:bg-[var(--color-surface-muted)]"}`}
        >
          <p className={`flex items-center gap-2 text-xs font-semibold ${active === metric.queue ? "text-[var(--color-primary)]" : "text-[var(--color-ink-soft)]"}`}>{metric.icon}{metric.label}</p>
          <p className="tnum mt-1 truncate text-lg font-semibold text-[var(--color-ink)]">{metric.value}</p>
          <p className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">{metric.hint}</p>
        </button>
      ))}
    </section>
  );
}

function MissingDeals({
  data,
  canSeeEmployeeDeals,
  focused,
}: {
  data: SettlementDashboardData;
  canSeeEmployeeDeals: boolean;
  focused: boolean;
}) {
  const targetRef = useDeepLinkTarget<HTMLElement>(focused);
  const state = settlementMissingDealsState({
    focused,
    canSeeEmployeeDeals,
    missingDealCount: data.missingDeals.length,
  });
  if (state === "hidden") return null;
  if (state === "permission-limited") {
    return (
      <section
        id="settlement-missing-deals"
        ref={targetRef}
        tabIndex={-1}
        className={`${deepLinkTargetClass(true)} border-l-4 border-[var(--color-info)] bg-[var(--color-info-soft)] px-4 py-3`}
        aria-label="Employee deal access limited"
      >
        <h2 className="text-sm font-semibold text-[var(--color-info)]">Employee deal status is limited</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">This account cannot verify whether employee deal rules are complete. Ask an administrator with employee-deal access to review them.</p>
      </section>
    );
  }
  if (state === "clear") {
    return (
      <section
        id="settlement-missing-deals"
        ref={targetRef}
        tabIndex={-1}
        className={`${deepLinkTargetClass(true)} border-l-4 border-[var(--color-success)] bg-[var(--color-success-soft)] px-4 py-3`}
        aria-label="Employees missing a deal"
      >
        <h2 className="text-sm font-semibold text-[var(--color-success)]">All employee deals are ready</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">There are no missing deal rules to fix.</p>
      </section>
    );
  }
  return (
    <section
      id="settlement-missing-deals"
      ref={targetRef}
      tabIndex={focused ? -1 : undefined}
      className={`${deepLinkTargetClass(focused)} border-l-4 border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3`}
      aria-label="Employees missing a deal"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-[var(--color-warn)]">
          {data.missingDeals.length} employee{data.missingDeals.length === 1 ? " needs" : "s need"} a deal
        </h2>
        <p className="text-xs text-[var(--color-ink-soft)]">Their transactions cannot create payment items yet.</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {data.missingDeals.map((employee) => (
          canSeeEmployeeDeals ? (
            <Link key={employee.employeeId} href={`/employees/${employee.employeeId}?view=deal`} className="font-medium text-[var(--color-primary)] hover:underline">
              Set deal for {employee.employeeName} <span className="font-normal text-[var(--color-ink-faint)]">({employee.transactionCount})</span>
            </Link>
          ) : (
            <span key={employee.employeeId} className="font-medium text-[var(--color-ink)]">
              {employee.employeeName} <span className="font-normal text-[var(--color-ink-faint)]">({employee.transactionCount})</span>
            </span>
          )
        ))}
      </div>
      {!canSeeEmployeeDeals ? (
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">An administrator with employee-deal access must set these rules.</p>
      ) : null}
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
        <caption className="sr-only">Payment obligations and current balances</caption>
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
        </tbody>
      </table>
    </div>
  );
}

export default function SettlementDashboard({
  data,
  canManage,
  canManagePayrollChecks,
  canSeeEmployeeDeals,
  canSeeTransactions,
  initialPersonName,
  initialPersonId,
  initialPersonType,
  initialQueueParam,
  initialFocusParam,
}: {
  data: SettlementDashboardData;
  canManage: boolean;
  canManagePayrollChecks: boolean;
  canSeeEmployeeDeals: boolean;
  canSeeTransactions: boolean;
  initialPersonName?: string | null;
  initialPersonId?: string | null;
  initialPersonType?: SettlementRow["personType"] | null;
  initialQueueParam?: string | null;
  initialFocusParam?: string | null;
}) {
  const router = useRouter();
  const requestedQueue = settlementQueueFromParam(initialQueueParam);
  const requestedFocus = settlementFocusFromParam(initialFocusParam);
  const defaultQueue: QueueFilter = requestedQueue ?? (initialPersonId && initialPersonType ? "all" : "open");
  const refreshTargetRef = useDeepLinkTarget<HTMLDivElement>(requestedFocus === "refresh");
  const initialFilters = useMemo<FilterState>(
    () => {
      return {
        ...settlementQueueFilters(defaultQueue),
        ...(initialPersonName ? { person: { selected: [initialPersonName] } } : {}),
        ...(initialPersonId && initialPersonType ? {
          personId: { selected: [initialPersonId] },
          personType: { selected: [initialPersonType] },
        } : {}),
      };
    },
    [defaultQueue, initialPersonId, initialPersonName, initialPersonType],
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
  const [queue, setQueue] = useState<QueueFilter>(defaultQueue);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
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
  const historyPageCount = Math.max(1, Math.ceil(filteredEvents.length / HISTORY_PAGE_SIZE));
  const visibleHistoryPage = Math.min(historyPage, historyPageCount - 1);
  const visibleHistoryEvents = filteredEvents.slice(
    visibleHistoryPage * HISTORY_PAGE_SIZE,
    (visibleHistoryPage + 1) * HISTORY_PAGE_SIZE,
  );
  const firstVisibleHistoryEntry = filteredEvents.length === 0
    ? 0
    : visibleHistoryPage * HISTORY_PAGE_SIZE + 1;
  const lastVisibleHistoryEntry = Math.min(
    filteredEvents.length,
    (visibleHistoryPage + 1) * HISTORY_PAGE_SIZE,
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

  const applyQueue = (next: QueueFilter) => {
    setQueue(next);
    setView("items");
    if (next === "all") {
      grid.clearFilters();
      return;
    }
    const filters = settlementQueueFilters(next);
    grid.setFilter("direction", filters.direction ?? null);
    grid.setFilter("state", filters.state ?? null);
  };

  const moveTabFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || tabs.length === 0) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  const selectionAction = useMemo(() => {
    const directions = new Set(selectedRows.map((row) => row.direction));
    if (directions.size !== 1) return "Record selected balances";
    const direction = [...directions][0];
    if (direction === "payable") return "Record agency payments";
    if (direction === "receivable") return "Record amounts received";
    return "Record set-asides";
  }, [selectedRows]);

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
      const refreshScope = initialPersonId && initialPersonType
        ? initialPersonType === "employee"
          ? { employeeId: initialPersonId }
          : { individualId: initialPersonId }
        : {};
      const result = await postJson<RefreshResult>("/api/settlements/refresh", refreshScope);
      const changed = result.created + result.updated + result.adjusted + result.voided;
      const blocked = result.skippedNoDeal
        + result.skippedMissingCheckIdentity
        + result.skippedMissingNet
        + result.skippedInconsistentNet
        + result.skippedInconsistentCheck
        + result.skippedMissingBase
        + result.skippedUnknownRecipient;
      setNotice({
        tone: "success",
        message: blocked > 0
          ? `Balances updated. ${blocked} source row${blocked === 1 ? " was" : "s were"} left unchanged.`
          : changed > 0
          ? `Payment items refreshed: ${result.created} new, ${result.updated} updated, ${result.adjusted} adjusted, ${result.voided} voided.`
          : "Payment items are up to date.",
      });
      setSelected(new Set());
      router.refresh();
    } catch (refreshError) {
      setNotice({ tone: "error", message: refreshError instanceof Error ? refreshError.message : "Payment items could not be refreshed." });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      <SummaryBand data={data} active={view === "items" ? queue : null} onSelect={applyQueue} />
      {canManage && requestedFocus === "missing-deals" ? (
        <MissingDeals
          data={data}
          canSeeEmployeeDeals={canSeeEmployeeDeals}
          focused={requestedFocus === "missing-deals"}
        />
      ) : null}
      {canManage ? (
        <CheckIssues
          data={data}
          canManagePayrollChecks={canManagePayrollChecks}
          canSeeTransactions={canSeeTransactions}
          focused={requestedFocus === "check-issues"}
        />
      ) : null}

      {data.freshness.dirty ? (
        <div role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          <p className="font-medium">Refresh required before recording payment activity.</p>
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
        <div role="tablist" aria-label="Payment views" className="flex gap-1" onKeyDown={moveTabFocus}>
          <button id="settlement-items-tab" type="button" role="tab" tabIndex={view === "items" && queue !== "completed" ? 0 : -1} aria-selected={view === "items" && queue !== "completed"} aria-controls="settlement-items-panel" onClick={() => applyQueue(queue === "completed" ? "open" : queue)} className={`border-b-2 px-3 py-2 text-sm font-medium ${view === "items" && queue !== "completed" ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
            Items <span className="tnum text-xs text-[var(--color-ink-faint)]">{grid.filtered.length}</span>
          </button>
          <button id="settlement-history-tab" type="button" role="tab" tabIndex={view === "history" ? 0 : -1} aria-selected={view === "history"} aria-controls="settlement-history-panel" onClick={() => { setHistoryPage(0); setView("history"); }} className={`border-b-2 px-3 py-2 text-sm font-medium ${view === "history" ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
            History <span className="tnum text-xs text-[var(--color-ink-faint)]">{filteredEvents.length}</span>
          </button>
          <button id="settlement-completed-tab" type="button" role="tab" tabIndex={view === "items" && queue === "completed" ? 0 : -1} aria-selected={view === "items" && queue === "completed"} aria-controls="settlement-items-panel" onClick={() => applyQueue("completed")} className={`border-b-2 px-3 py-2 text-sm font-medium ${view === "items" && queue === "completed" ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
            Completed <span className="tnum text-xs text-[var(--color-ink-faint)]">{data.summary.settledCount}</span>
          </button>
        </div>
        {canManage || requestedFocus === "refresh" ? (
          <div
            id="settlement-refresh"
            ref={refreshTargetRef}
            tabIndex={requestedFocus === "refresh" ? -1 : undefined}
            className={`${deepLinkTargetClass(requestedFocus === "refresh")} mb-1`}
          >
            {canManage ? (
              <button type="button" disabled={refreshing} onClick={refresh} className="btn btn-sm btn-secondary">
                {refreshing ? "Refreshing..." : "Refresh items"}
              </button>
            ) : (
              <p className="max-w-sm text-xs text-[var(--color-ink-soft)]">An administrator with Money operations access must refresh these balances.</p>
            )}
          </div>
        ) : null}
      </div>

      <section id={view === "items" ? "settlement-items-panel" : "settlement-history-panel"} role="tabpanel" aria-labelledby={view === "items" ? queue === "completed" ? "settlement-completed-tab" : "settlement-items-tab" : "settlement-history-tab"} className="space-y-3">
        {view === "items" ? (
          <>
            <Toolbar
              grid={grid}
              searchPlaceholder="Search person, item, check, or date"
              exportEndpoint="/api/grid/export"
              exportTitle="Payment obligations"
              exportFilename="settlements"
              hasExternalFilters={queue !== "all"}
              onResetFilters={() => {
                setQueue("all");
                setSelected(new Set());
              }}
              extraActions={canManage ? (
                <>
                  {selectedRows.length > 0 ? <span className="tnum text-xs font-medium text-[var(--color-primary)]">{selectedRows.length} selected</span> : null}
                  <button type="button" disabled={!canRecord || selectedRows.length === 0} onClick={() => setSettleOpen(true)} className="btn btn-sm btn-primary">
                    {selectionAction}
                  </button>
                </>
              ) : undefined}
            />
            <FilterBar grid={grid} />
            {grid.sorted.length === 0 ? (
              <div className="border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
                <EmptyState
                  title={data.rows.length === 0
                    ? "No payment items yet"
                    : queue === "completed"
                      ? "No completed payments yet"
                      : queue === "open" && data.summary.settledCount > 0
                        ? "No open payment work"
                        : "No payment items match this view"}
                  action={data.rows.length > 0 ? (
                    <div className="flex flex-wrap justify-center gap-2">
                      {queue !== "completed" && data.summary.settledCount > 0 ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() => {
                            grid.clearFilters();
                            applyQueue("completed");
                          }}
                        >
                          <BadgeCheck aria-hidden className="h-4 w-4" /> View completed
                        </button>
                      ) : null}
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => applyQueue("all")}>
                        <CreditCard aria-hidden className="h-4 w-4" /> Show all {data.rows.length.toLocaleString()} items
                      </button>
                    </div>
                  ) : undefined}
                >
                  {data.rows.length === 0
                    ? "Refresh items to calculate payment obligations from committed payroll and active plans."
                    : queue === "open" && data.summary.settledCount > 0
                      ? `${data.summary.settledCount.toLocaleString()} completed payment ${data.summary.settledCount === 1 ? "is" : "items are"} available in Completed.`
                      : `${data.rows.length.toLocaleString()} payment ${data.rows.length === 1 ? "item exists" : "items exist"}, but the current queue, search, or filters hide them.`}
                </EmptyState>
              </div>
            ) : (
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
            )}
          </>
        ) : (
          <>
            <label className="block max-w-xl">
              <span className="sr-only">Search payment history</span>
              <input value={historySearch} onChange={(event) => { setHistorySearch(event.target.value); setHistoryPage(0); }} className="input w-full" placeholder="Search person, reference, note, or actor" />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-ink-soft)]">
              <p>
                Showing {firstVisibleHistoryEntry.toLocaleString()}-{lastVisibleHistoryEntry.toLocaleString()} of {filteredEvents.length.toLocaleString()} complete history {filteredEvents.length === 1 ? "entry" : "entries"}.
              </p>
              {historyPageCount > 1 ? (
                <div className="flex items-center gap-1" aria-label="Payment history pages">
                  <button type="button" className="btn btn-sm btn-ghost" disabled={visibleHistoryPage === 0} onClick={() => setHistoryPage(Math.max(0, visibleHistoryPage - 1))}>
                    <ChevronLeft size={15} aria-hidden /> Previous
                  </button>
                  <span className="tnum px-2">Page {visibleHistoryPage + 1} of {historyPageCount}</span>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={visibleHistoryPage >= historyPageCount - 1} onClick={() => setHistoryPage(Math.min(historyPageCount - 1, visibleHistoryPage + 1))}>
                    Next <ChevronRight size={15} aria-hidden />
                  </button>
                </div>
              ) : null}
            </div>
            <HistoryTable events={visibleHistoryEvents} canManage={canRecord} onReverse={setReverseEvent} />
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

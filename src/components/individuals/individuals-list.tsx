"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui";
import { type UtilizationStatus, UtilizationBadge, utilizationLabel } from "@/components/ui-viz";
import { ColumnChooser, Toolbar } from "@/components/data-grid/toolbar";
import { useGrid } from "@/components/data-grid/use-grid";
import type { ColumnDef, SortState } from "@/components/data-grid/types";
import { BUDGET_STATUS_PRESENT, type BudgetLineStatus } from "@/lib/business/budget-status";
import { isActiveOverAuthorization } from "@/lib/business/budget-board-status";
import { formatHours, formatMoney } from "@/lib/money";
import { individualBudgetHref } from "@/lib/nav/review-actions";
import {
  DEFAULT_HIDDEN_PORTFOLIO_COLUMNS,
  isDetailedPortfolioView,
  matchesSimplePortfolioView,
  portfolioViewHref,
  type DetailedPortfolioView,
  type PortfolioView,
} from "@/components/individuals/portfolio-view";
import {
  authorizedHours,
  computePeopleBudgetTotals,
  individualNextAction,
  matchesPeopleStatus,
  matchesProgram,
  matchesRenewal,
  type PeopleStatusFilter,
  type RenewalFilter,
} from "@/components/individuals/people-budget-table";

export type IndividualBudget = {
  status: UtilizationStatus;
  plainStatus: BudgetLineStatus;
  usedPct: number | null;
  elapsedPct: number | null;
  renews: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  periodCount?: number;
  missingRenewal: boolean;
  renewalCount: number;
  usedHours: number;
  hoursLeft: number | null;
  scheduledHours: number;
  hoursAfterScheduled: number | null;
  plans: number;
  daysToRenewal: number | null;
  expired: boolean;
  mustUseMonthly: number | null;
  mustUseWeekly: number | null;
  transactionCount: number | null;
  billedAmount: string | null;
};

export type IndividualRow = {
  id: string;
  name: string;
  preferredName: string | null;
  status: string;
  archived: boolean;
  programs: string[];
  budget: IndividualBudget | null;
  hasCanonicalBudget: boolean;
  hasBilling: boolean;
  lastBilledOn: string | null;
  insightsVisible: boolean;
};

type PortfolioFilter = PortfolioView;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LOCKED_COLUMNS: ReadonlySet<string> = new Set(["name"]);
const DEFAULT_SORT: SortState = [{ key: "renews", dir: "asc" }];

const STATUS_FILTERS: Array<{ value: PeopleStatusFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "all", label: "All statuses" },
  { value: "inactive", label: "Inactive" },
  { value: "discharged", label: "Discharged" },
  { value: "archived", label: "Archived" },
];

const RENEWAL_FILTERS: Array<{ value: RenewalFilter; label: string }> = [
  { value: "all", label: "Any renewal" },
  { value: "next_30", label: "Due in 30 days" },
  { value: "next_60", label: "Due in 60 days" },
  { value: "next_90", label: "Due in 90 days" },
  { value: "overdue", label: "Overdue" },
  { value: "missing", label: "Missing date" },
];

const STATUS_FILTER_VALUES = new Set(STATUS_FILTERS.map((option) => option.value));
const RENEWAL_FILTER_VALUES = new Set(RENEWAL_FILTERS.map((option) => option.value));

const DETAIL_FILTERS: Array<{ key: DetailedPortfolioView; label: string }> = [
  { key: "attention", label: "Follow-up list" },
  { key: "at_limit", label: "At or over the hour limit" },
  { key: "over", label: "Over the hour limit" },
  { key: "behind", label: "Behind planned pace" },
  { key: "renewing", label: "Renewing in 60 days" },
  { key: "billing_without_budget", label: "Billing found, no budget" },
  { key: "no_activity", label: "No billing activity" },
];

const PORTFOLIO_FILTER_VALUES = new Set<PortfolioFilter>([
  "all",
  "with_budget",
  "without_budget",
  ...DETAIL_FILTERS.map((option) => option.key),
]);

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}

function isOver(row: IndividualRow): boolean {
  return row.insightsVisible && isActiveOverAuthorization(row);
}

function isBehind(row: IndividualRow): boolean {
  return row.insightsVisible && row.budget?.status === "behind_pace";
}

function isAtLimit(row: IndividualRow): boolean {
  return row.insightsVisible && (
    isOver(row)
    || row.budget?.status === "near_exhaustion"
    || row.budget?.status === "fully_used"
  );
}

function isRenewing(row: IndividualRow): boolean {
  const days = row.budget?.daysToRenewal;
  return row.insightsVisible && days !== null && days !== undefined && days >= 0 && days <= 60;
}

function hasBillingWithoutBudget(row: IndividualRow): boolean {
  return row.insightsVisible
    && row.status === "active"
    && !row.archived
    && row.hasBilling
    && !row.hasCanonicalBudget;
}

function hasNoActivity(row: IndividualRow): boolean {
  return row.insightsVisible && !row.hasBilling;
}

function needsAttention(row: IndividualRow): boolean {
  if (row.status !== "active" || row.archived || !row.insightsVisible) return false;
  return isOver(row)
    || isBehind(row)
    || isRenewing(row)
    || hasBillingWithoutBudget(row)
    || hasNoActivity(row)
    || row.budget?.missingRenewal === true
    || row.budget?.expired === true
    || row.budget?.status === "near_exhaustion"
    || row.budget?.status === "fully_used";
}

function matchesFilter(row: IndividualRow, filter: PortfolioFilter): boolean {
  if (filter === "with_budget" || filter === "without_budget") return matchesSimplePortfolioView(row, filter);
  if (filter === "attention") return needsAttention(row);
  if (filter === "over") return row.status === "active" && isOver(row);
  if (filter === "at_limit") return row.status === "active" && isAtLimit(row);
  if (filter === "behind") return row.status === "active" && isBehind(row);
  if (filter === "renewing") return row.status === "active" && isRenewing(row);
  if (filter === "billing_without_budget") return row.status === "active" && hasBillingWithoutBudget(row);
  if (filter === "no_activity") return row.status === "active" && hasNoActivity(row);
  return true;
}

function healthRank(row: IndividualRow): number {
  if (!row.insightsVisible) return 99;
  if (hasBillingWithoutBudget(row)) return 0;
  if (!row.budget) return hasNoActivity(row) ? 6 : 98;
  if (row.budget.expired) return 1;
  const rank: Record<UtilizationStatus, number> = {
    over_authorization: 0,
    fully_used: 2,
    near_exhaustion: 3,
    behind_pace: 4,
    not_started: 5,
    ahead_of_pace: 7,
    on_pace: 8,
  };
  return rank[row.budget.status];
}

function healthLabel(row: IndividualRow): string | null {
  if (!row.insightsVisible) return null;
  if (row.budget) return utilizationLabel(row.budget.status);
  return row.hasCanonicalBudget ? "Dollar allowance" : "No budget";
}

function SummaryMetric({ label, value }: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className="truncate text-xs font-medium text-[var(--color-ink-soft)]">{label}</dt>
      <dd className="tnum mt-1 text-lg font-semibold leading-none text-[var(--color-ink)]">{value}</dd>
    </div>
  );
}

function PaceBar({ budget }: { budget: IndividualBudget }) {
  const rawUsed = Math.max(0, budget.usedPct ?? 0);
  const used = Math.min(100, rawUsed);
  const color = BUDGET_STATUS_PRESENT[budget.plainStatus].color;
  return (
    <div
      className={`pace-track mt-1.5 ${rawUsed > 100 ? "pace-track-over" : ""}`}
      role="img"
      aria-label={`${Math.round(rawUsed)}% of budget hours used`}
      title={budget.elapsedPct !== null
        ? `${Math.round(rawUsed)}% used; ${Math.round(budget.elapsedPct)}% of the budget period elapsed`
        : `${Math.round(rawUsed)}% of hours used`}
    >
      <div className="pace-fill" style={{ width: `${used}%`, background: rawUsed > 100 ? "var(--color-danger)" : color }} />
      {budget.elapsedPct !== null ? (
        <div className="pace-notch" style={{ left: `${Math.max(0, Math.min(100, budget.elapsedPct))}%` }} />
      ) : null}
    </div>
  );
}

function Renewal({ budget }: { budget: IndividualBudget }) {
  if (budget.missingRenewal) {
    return <span className="font-semibold text-[var(--color-danger)]">Renewal missing</span>;
  }
  if (budget.renews === null) return <span className="text-[var(--color-ink-faint)]">-</span>;
  const days = budget.daysToRenewal;
  const detail = budget.expired && days !== null
    ? `${Math.abs(days)}d overdue`
    : days === 0
      ? "Due today"
      : days !== null && days <= 60
        ? `In ${days}d`
        : null;
  const tone = budget.expired
    ? "text-[var(--color-danger)]"
    : days !== null && days <= 60
      ? "text-[var(--color-warn)]"
      : "text-[var(--color-ink-soft)]";
  return (
    <div className={tone}>
      <p className="tnum whitespace-nowrap font-medium">{formatDate(budget.renews)}</p>
      {budget.renewalCount > 1 ? (
        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
          Next of {budget.renewalCount} program dates
        </p>
      ) : null}
      {detail ? <p className="mt-0.5 text-xs font-medium">{detail}</p> : null}
    </div>
  );
}

function AuthorizationPeriod({ budget }: { budget: IndividualBudget }) {
  if (!budget.periodStart || !budget.periodEnd) {
    return <span className="text-[var(--color-ink-faint)]">-</span>;
  }
  return (
    <div className="text-[var(--color-ink-soft)]">
      <p className="tnum whitespace-nowrap font-medium text-[var(--color-ink)]">
        {formatDate(budget.periodStart)} – {formatDate(budget.periodEnd)}
      </p>
      {(budget.periodCount ?? 0) > 1 ? (
        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
          Next of {budget.periodCount ?? 0} program periods
        </p>
      ) : null}
    </div>
  );
}

function remainingHours(budget: IndividualBudget): string {
  if (budget.hoursLeft === null) return "-";
  if (budget.hoursLeft < 0) return `${formatHours(Math.abs(budget.hoursLeft))} h over`;
  return `${formatHours(budget.hoursLeft)} h`;
}

function requiredMonthly(budget: IndividualBudget): string {
  if (budget.expired && (budget.hoursLeft ?? 0) > 0) return "Past renewal";
  if (budget.daysToRenewal === 0 && (budget.hoursLeft ?? 0) > 0) return "Due now";
  if (budget.mustUseMonthly !== null && budget.mustUseMonthly > 0) return `${formatHours(budget.mustUseMonthly)} h/month`;
  if (budget.hoursLeft !== null && budget.hoursLeft <= 0) return "None";
  return "-";
}

function requiredWeekly(budget: IndividualBudget): string {
  if (budget.expired && (budget.hoursLeft ?? 0) > 0) return "Past renewal";
  if (budget.daysToRenewal === 0 && (budget.hoursLeft ?? 0) > 0) return "Due now";
  if (budget.mustUseWeekly !== null && budget.mustUseWeekly > 0) return `${formatHours(budget.mustUseWeekly)} h/week`;
  if (budget.hoursLeft !== null && budget.hoursLeft <= 0) return "None";
  return "-";
}

function HealthCell({ row }: { row: IndividualRow }) {
  if (!row.insightsVisible) return <span className="text-[var(--color-ink-faint)]">-</span>;
  if (row.budget) {
    return (
      <Link
        href={individualBudgetHref(row.id)}
        className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        title={`Open ${row.name}'s budget`}
      >
        <UtilizationBadge status={row.budget.status} />
        <p className="mt-1 text-xs font-medium text-[var(--color-ink-soft)]">
          {row.budget.usedPct !== null ? `${Math.round(row.budget.usedPct)}% used` : "Usage not available"}
          {row.budget.elapsedPct !== null ? ` · ${Math.round(row.budget.elapsedPct)}% elapsed` : ""}
        </p>
        <PaceBar budget={row.budget} />
      </Link>
    );
  }
  if (row.hasCanonicalBudget) {
    return (
      <Link href={individualBudgetHref(row.id)} className="text-sm font-medium text-[var(--color-primary)] underline-offset-2 hover:underline">
        Dollar allowance
      </Link>
    );
  }
  return (
    <Link href={individualBudgetHref(row.id)} className="text-sm text-[var(--color-ink-soft)] underline-offset-2 hover:text-[var(--color-primary)] hover:underline">
      No budget
    </Link>
  );
}

function NextActionCell({ row }: { row: IndividualRow }) {
  const action = individualNextAction(row);
  const href = action.destination === "budget"
    ? individualBudgetHref(row.id)
    : `/individuals/${encodeURIComponent(row.id)}`;
  const tone = action.tone === "danger"
    ? "text-[var(--color-danger)]"
    : action.tone === "warn"
      ? "text-[var(--color-warn)]"
      : action.tone === "primary"
        ? "text-[var(--color-primary)]"
        : "text-[var(--color-ink-soft)]";
  return (
    <Link href={href} className={`font-semibold underline-offset-2 hover:underline ${tone}`}>
      {action.label}
    </Link>
  );
}

function SortHead({ column, sort, onSort }: {
  column: ColumnDef<IndividualRow>;
  sort: SortState;
  onSort: (key: string, additive: boolean) => void;
}) {
  const active = sort.find((item) => item.key === column.key);
  const Icon = active ? (active.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  const align = column.align ?? "left";
  return (
    <th
      aria-sort={active ? (active.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 font-semibold ${align === "right" ? "text-right" : "text-left"}`}
      style={column.width ? { minWidth: column.width } : undefined}
    >
      <button
        type="button"
        onClick={(event) => onSort(column.key, event.shiftKey)}
        className={`inline-flex items-center gap-1.5 hover:text-[var(--color-primary)] ${align === "right" ? "flex-row-reverse" : ""}`}
        title={`Sort by ${column.label}`}
      >
        {column.label}
        <Icon size={13} className={active ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"} aria-hidden />
      </button>
    </th>
  );
}

export default function IndividualsList({
  rows,
  initialFilter = "all",
  canManage = false,
}: {
  rows: IndividualRow[];
  initialFilter?: PortfolioView;
  canManage?: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState<PeopleStatusFilter>("active");
  const [programFilter, setProgramFilter] = useState("");
  const [renewalFilter, setRenewalFilter] = useState<RenewalFilter>("all");
  const [filter, setFilter] = useState<PortfolioFilter>(initialFilter);
  const [moreOpen, setMoreOpen] = useState(isDetailedPortfolioView(initialFilter));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const chooseFilter = useCallback((next: PortfolioFilter) => {
    setFilter(next);
    if (typeof window !== "undefined") window.history.replaceState(null, "", portfolioViewHref(next));
  }, []);

  const resetExternalFilters = useCallback(() => {
    setStatusFilter("active");
    setProgramFilter("");
    setRenewalFilter("all");
    chooseFilter("all");
  }, [chooseFilter]);

  const activeRows = useMemo(
    () => rows.filter((row) => row.status === "active" && !row.archived),
    [rows],
  );
  const hasPortfolioVisibility = rows.some((row) => row.insightsVisible);
  const counts = useMemo(() => ({
    all: activeRows.length,
    with_budget: activeRows.filter((row) => row.insightsVisible && row.hasCanonicalBudget).length,
    without_budget: activeRows.filter((row) => row.insightsVisible && !row.hasCanonicalBudget).length,
    attention: activeRows.filter(needsAttention).length,
    over: activeRows.filter(isOver).length,
    at_limit: activeRows.filter(isAtLimit).length,
    behind: activeRows.filter(isBehind).length,
    renewing: activeRows.filter(isRenewing).length,
    billing_without_budget: activeRows.filter(hasBillingWithoutBudget).length,
    no_activity: activeRows.filter(hasNoActivity).length,
  }), [activeRows]);

  const programOptions = useMemo(
    () => [...new Set(rows.flatMap((row) => row.programs))].sort((left, right) => left.localeCompare(right)),
    [rows],
  );

  const externalConfig = useMemo(() => ({
    status: statusFilter,
    program: programFilter,
    renewal: renewalFilter,
    portfolio: filter,
  }), [filter, programFilter, renewalFilter, statusFilter]);

  const applyExternalConfig = useCallback((config: Record<string, string>) => {
    setStatusFilter(STATUS_FILTER_VALUES.has(config.status as PeopleStatusFilter)
      ? config.status as PeopleStatusFilter
      : "active");
    setProgramFilter(programOptions.includes(config.program) ? config.program : "");
    setRenewalFilter(RENEWAL_FILTER_VALUES.has(config.renewal as RenewalFilter)
      ? config.renewal as RenewalFilter
      : "all");
    chooseFilter(PORTFOLIO_FILTER_VALUES.has(config.portfolio as PortfolioFilter)
      ? config.portfolio as PortfolioFilter
      : "all");
  }, [chooseFilter, programOptions]);

  const portfolioRows = useMemo(
    () => rows
      .filter((row) => matchesPeopleStatus(row, statusFilter))
      .filter((row) => matchesProgram(row, programFilter))
      .filter((row) => matchesRenewal(row, renewalFilter))
      .filter((row) => matchesFilter(row, filter)),
    [filter, programFilter, renewalFilter, rows, statusFilter],
  );
  const canShowTransactionCounts = rows.some((row) => row.budget?.transactionCount !== null && row.budget?.transactionCount !== undefined);
  const canShowBilledAmounts = rows.some((row) => row.budget?.billedAmount !== null && row.budget?.billedAmount !== undefined);

  const columns = useMemo<ColumnDef<IndividualRow>[]>(() => [
    {
      key: "name", label: "Individual", kind: "text", frozen: true, width: 180,
      accessor: (row) => `${row.name} ${row.preferredName ?? ""}`.trim(),
      render: (row) => (
        <div>
          <Link className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${row.id}`}>
            {row.name}
          </Link>
          {row.preferredName ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Prefers {row.preferredName}</p> : null}
        </div>
      ),
    },
    {
      key: "status", label: "Status", kind: "badge", width: 100,
      accessor: (row) => row.status,
      render: (row) => <Badge value={row.status} />,
    },
    {
      key: "programs", label: "Active programs", kind: "text", width: 190,
      accessor: (row) => row.programs.join(", ") || null,
      render: (row) => <span className="text-[var(--color-ink-soft)]">{row.programs.length ? row.programs.join(", ") : "-"}</span>,
    },
    {
      key: "authorizationPeriod", label: "Authorization period", kind: "text", width: 250,
      accessor: (row) => row.budget?.periodStart && row.budget.periodEnd
        ? `${row.budget.periodStart} – ${row.budget.periodEnd}`
        : null,
      render: (row) => row.budget
        ? <AuthorizationPeriod budget={row.budget} />
        : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "renews", label: "Renewal", kind: "date", width: 168,
      accessor: (row) => row.budget?.renews ?? null,
      sortAccessor: (row) => row.budget?.renews ?? "9999-12-31",
      render: (row) => row.budget ? <Link href={individualBudgetHref(row.id)} className="block underline-offset-2 hover:underline"><Renewal budget={row.budget} /></Link> : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "authorized", label: "Authorized", kind: "hours", align: "right", width: 110,
      accessor: (row) => row.budget ? authorizedHours(row.budget) : null,
      render: (row) => {
        const value = row.budget ? authorizedHours(row.budget) : null;
        return value === null
          ? <span className="text-[var(--color-ink-faint)]">-</span>
          : <span className="tnum font-medium">{formatHours(value)} h</span>;
      },
    },
    {
      key: "billedHours", label: "Actual used", kind: "hours", align: "right", width: 110,
      accessor: (row) => row.budget?.usedHours.toString() ?? null,
      render: (row) => row.budget
        ? <span className="tnum font-medium">{formatHours(row.budget.usedHours)} h</span>
        : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "scheduled", label: "Future scheduled", kind: "hours", align: "right", width: 130,
      accessor: (row) => row.budget?.scheduledHours.toString() ?? null,
      render: (row) => row.budget ? <span className="tnum font-medium">{formatHours(row.budget.scheduledHours)} h</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "left", label: "Remaining", kind: "hours", align: "right", width: 110,
      accessor: (row) => row.budget?.hoursLeft?.toString() ?? null,
      render: (row) => row.budget ? <span className={`tnum font-medium ${isOver(row) ? "text-[var(--color-danger)]" : ""}`}>{remainingHours(row.budget)}</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "afterScheduled", label: "Remaining after schedule", kind: "hours", align: "right", width: 165,
      accessor: (row) => row.budget?.hoursAfterScheduled?.toString() ?? null,
      render: (row) => row.budget ? (
        <span className={`tnum font-medium ${(row.budget.hoursAfterScheduled ?? 0) < 0 ? "text-[var(--color-danger)]" : ""}`}>
          {row.budget.hoursAfterScheduled === null ? "-" : `${formatHours(row.budget.hoursAfterScheduled)} h`}
        </span>
      ) : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "health", label: "Pace / status", kind: "custom", width: 185,
      accessor: healthLabel,
      sortAccessor: (row) => String(healthRank(row)),
      render: (row) => <HealthCell row={row} />,
    },
    {
      key: "nextAction", label: "Next action", kind: "text", width: 190,
      accessor: (row) => individualNextAction(row).label,
      render: (row) => <NextActionCell row={row} />,
    },
    {
      key: "monthly", label: "Required / month", kind: "hours", align: "right", width: 135,
      accessor: (row) => row.budget?.mustUseMonthly?.toString() ?? null,
      render: (row) => row.budget ? <span className="tnum font-medium">{requiredMonthly(row.budget)}</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "lastBilled", label: "Last billed", kind: "date", width: 125,
      accessor: (row) => row.lastBilledOn,
      render: (row) => row.lastBilledOn ? <span className="tnum whitespace-nowrap text-[var(--color-ink-soft)]">{formatDate(row.lastBilledOn)}</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "used", label: "Used %", kind: "percent", align: "right", width: 90,
      accessor: (row) => row.budget?.usedPct?.toString() ?? null,
      render: (row) => row.budget?.usedPct === null || row.budget?.usedPct === undefined ? <span className="text-[var(--color-ink-faint)]">-</span> : <span className="tnum font-medium">{Math.round(row.budget.usedPct)}%</span>,
    },
    {
      key: "weekly", label: "Required / week", kind: "hours", align: "right", width: 130,
      accessor: (row) => row.budget?.mustUseWeekly?.toString() ?? null,
      render: (row) => row.budget ? <span className="tnum font-medium">{requiredWeekly(row.budget)}</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    ...(canShowTransactionCounts ? [{
      key: "transactions", label: "Transactions", kind: "int", align: "right", width: 105,
      accessor: (row) => row.budget?.transactionCount?.toString() ?? null,
      render: (row) => row.budget?.transactionCount === null || row.budget?.transactionCount === undefined ? <span className="text-[var(--color-ink-faint)]">-</span> : <span className="tnum">{row.budget.transactionCount.toLocaleString()}</span>,
    } satisfies ColumnDef<IndividualRow>] : []),
    ...(canShowBilledAmounts ? [{
      key: "billedAmount", label: "Funder billed", kind: "money", align: "right", width: 120,
      accessor: (row) => row.budget?.billedAmount ?? null,
      render: (row) => row.budget?.billedAmount ? <span className="tnum font-medium">{formatMoney(row.budget.billedAmount)}</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
    } satisfies ColumnDef<IndividualRow>] : []),
  ], [canShowBilledAmounts, canShowTransactionCounts]);

  const computeTotals = useCallback(
    (filteredRows: IndividualRow[]) => computePeopleBudgetTotals(
      selectedIds.size > 0
        ? filteredRows.filter((row) => selectedIds.has(row.id))
        : filteredRows,
    ),
    [selectedIds],
  );
  const exportRowPredicate = useCallback(
    (row: IndividualRow) => selectedIds.size === 0 || selectedIds.has(row.id),
    [selectedIds],
  );

  const grid = useGrid<IndividualRow, ReturnType<typeof computePeopleBudgetTotals>>({
    rows: portfolioRows,
    columns,
    gridKey: "individual-budget-portfolio",
    canManage,
    initialSort: DEFAULT_SORT,
    initialHidden: [...DEFAULT_HIDDEN_PORTFOLIO_COLUMNS],
    searchKeys: ["name", "programs"],
    computeTotals,
    externalConfig,
    onApplyExternalConfig: applyExternalConfig,
    exportRowPredicate,
    serializeHidden: true,
  });

  const filteredIds = useMemo(() => grid.filtered.map((row) => row.id), [grid.filtered]);
  const selectedRows = useMemo(
    () => grid.filtered.filter((row) => selectedIds.has(row.id)),
    [grid.filtered, selectedIds],
  );
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someFilteredSelected = filteredIds.some((id) => selectedIds.has(id));
  const toggleAllFiltered = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const remove = filteredIds.length > 0 && filteredIds.every((id) => next.has(id));
      for (const id of filteredIds) {
        if (remove) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [filteredIds]);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const hasActiveFilters = grid.anyFilter
    || filter !== "all"
    || statusFilter !== "active"
    || programFilter !== ""
    || renewalFilter !== "all";
  const resetFilters = () => {
    grid.clearFilters();
    resetExternalFilters();
  };

  return (
    <div className="space-y-4">
      <section aria-label="Individual budget portfolio summary" className="border-y border-[var(--color-rule-strong)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] px-4 py-2 text-xs text-[var(--color-ink-soft)]">
          <span>
            {selectedIds.size > 0
              ? `Totals for ${selectedRows.length.toLocaleString()} selected people in the current view`
              : "Totals for everyone in the current view"}
          </span>
          {selectedIds.size > 0 ? (
            <button type="button" onClick={() => setSelectedIds(new Set())} className="font-medium text-[var(--color-primary)] hover:underline">
              Clear selection
            </button>
          ) : null}
        </div>
        <dl className={`grid divide-x divide-[var(--color-rule)] ${hasPortfolioVisibility ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-1"}`}>
          <SummaryMetric label="People" value={(grid.totals?.people ?? 0).toLocaleString()} />
          {hasPortfolioVisibility && grid.totals ? (
            <>
              <SummaryMetric label="Authorized" value={`${formatHours(grid.totals.authorizedHours)} h`} />
              <SummaryMetric label="Actual used" value={`${formatHours(grid.totals.usedHours)} h`} />
              <SummaryMetric label="Future scheduled" value={`${formatHours(grid.totals.scheduledHours)} h`} />
              <SummaryMetric label="After schedule" value={`${formatHours(grid.totals.remainingAfterScheduledHours)} h`} />
            </>
          ) : null}
        </dl>
      </section>

      <div className="space-y-3">
        <Toolbar
          grid={grid}
          searchPlaceholder="Search individuals or programs…"
          exportEndpoint="/api/grid/export"
          exportTitle="People and budgets"
          exportFilename="people-and-budgets"
          showColumnChooser={false}
          hasExternalFilters={filter !== "all" || statusFilter !== "active" || programFilter !== "" || renewalFilter !== "all"}
          onResetFilters={resetExternalFilters}
          extraActions={selectedIds.size > 0 ? (
            <span role="status" aria-live="polite" className="text-xs font-medium text-[var(--color-primary)]">
              {selectedRows.length.toLocaleString()} selected · exports use this selection
            </span>
          ) : null}
        />

        <div className="flex flex-wrap items-end gap-3" aria-label="People and budget filters">
          <label className="block min-w-36 text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as PeopleStatusFilter)}
              className="select w-full"
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-48 text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Program</span>
            <select
              value={programFilter}
              onChange={(event) => setProgramFilter(event.target.value)}
              className="select w-full"
              disabled={programOptions.length === 0}
            >
              <option value="">All programs</option>
              {programOptions.map((program) => <option key={program} value={program}>{program}</option>)}
            </select>
          </label>
          <label className="block min-w-44 text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Renewal</span>
            <select
              value={renewalFilter}
              onChange={(event) => setRenewalFilter(event.target.value as RenewalFilter)}
              className="select w-full"
              disabled={!hasPortfolioVisibility}
            >
              {RENEWAL_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        {hasPortfolioVisibility ? (
          <div className="segmented-control w-fit max-w-full overflow-x-auto" role="group" aria-label="Show people by budget setup">
            {([
              { key: "all", label: "All", count: counts.all },
              { key: "with_budget", label: "With budget", count: counts.with_budget },
              { key: "without_budget", label: "No budget", count: counts.without_budget },
            ] as const).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => chooseFilter(option.key)}
                aria-pressed={filter === option.key}
                className="whitespace-nowrap"
              >
                {option.label} <span className="tnum opacity-70">{option.count}</span>
              </button>
            ))}
          </div>
        ) : null}

        <details
          className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)]"
          open={moreOpen}
          onToggle={(event) => setMoreOpen(event.currentTarget.open)}
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-[var(--color-ink-soft)] marker:hidden hover:text-[var(--color-ink)]">
            <SlidersHorizontal size={15} aria-hidden />
            <span>More filters and columns</span>
            {isDetailedPortfolioView(filter) ? (
              <span className="ml-auto text-xs font-normal text-[var(--color-primary)]">
                {DETAIL_FILTERS.find((option) => option.key === filter)?.label}
              </span>
            ) : null}
          </summary>
          <div className="flex flex-wrap items-end gap-4 border-t border-[var(--color-rule)] px-3 py-3">
            {hasPortfolioVisibility ? (
              <label className="block min-w-56 text-sm">
                <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Detailed view</span>
                <select
                  value={isDetailedPortfolioView(filter) ? filter : ""}
                  onChange={(event) => chooseFilter((event.target.value || "all") as PortfolioFilter)}
                  className="select w-full"
                >
                  <option value="">None</option>
                  {DETAIL_FILTERS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label} ({counts[option.key]})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div>
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Table details</span>
              <ColumnChooser grid={grid} lockedKeys={LOCKED_COLUMNS} />
            </div>
          </div>
        </details>
      </div>

      <div className="scroll-thin max-h-[62vh] overflow-auto rounded-md border border-[var(--color-rule-strong)]">
        <table className="touch-table w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <th
                scope="col"
                className="w-12 border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-2 py-2 text-center"
              >
                <input
                  type="checkbox"
                  aria-label="Select all people in the current filters"
                  checked={allFilteredSelected}
                  ref={(element) => {
                    if (element) element.indeterminate = !allFilteredSelected && someFilteredSelected;
                  }}
                  onChange={toggleAllFiltered}
                />
              </th>
              {grid.visibleColumns.map((column) => (
                <SortHead key={column.key} column={column} sort={grid.sort} onSort={grid.toggleSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.sorted.map((row) => (
              <tr key={row.id} className={`border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)] ${selectedIds.has(row.id) ? "bg-[var(--color-primary-tint)]" : ""} ${row.archived ? "opacity-70" : ""}`}>
                <td className="border-r border-[var(--color-rule)] px-2 py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleSelected(row.id)}
                    aria-label={`Select ${row.name}`}
                  />
                </td>
                {grid.visibleColumns.map((column) => {
                  const text = column.accessor(row) ?? "";
                  const align = column.align ?? "left";
                  return (
                    <td
                      key={column.key}
                      className={`px-3 py-2.5 ${align === "right" ? "text-right" : "text-left"}`}
                      style={column.width ? { minWidth: column.width } : undefined}
                    >
                      {column.render ? column.render(row, text, { editing: false, canManage: false }) : text || "-"}
                    </td>
                  );
                })}
              </tr>
            ))}
            {grid.sorted.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, grid.visibleColumns.length + 1)} className="px-3 py-12 text-center text-[var(--color-text-soft)]">
                  <p>{rows.length === 0 ? "No individuals yet." : "No individuals match these filters."}</p>
                  {hasActiveFilters ? (
                    <button type="button" onClick={resetFilters} className="mt-2 font-medium text-[var(--color-primary)] hover:underline">
                      Clear filters
                    </button>
                  ) : null}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarClock,
  Clock3,
  Gauge,
  ReceiptText,
  Search,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui";
import { type UtilizationStatus } from "@/components/ui-viz";
import { ColumnChooser } from "@/components/data-grid/toolbar";
import { useGrid } from "@/components/data-grid/use-grid";
import type { ColumnDef, SortState } from "@/components/data-grid/types";
import { BUDGET_STATUS_PRESENT, type BudgetLineStatus } from "@/lib/business/budget-status";
import { isActiveBillingWithoutBudget, isActiveOverAuthorization } from "@/lib/business/budget-board-status";
import { dec, formatHours, formatMoney } from "@/lib/money";
import {
  individualBudgetHref,
  individualPortfolioHref,
  type IndividualAttentionView,
} from "@/lib/nav/review-actions";

export type IndividualBudget = {
  status: UtilizationStatus;
  plainStatus: BudgetLineStatus;
  usedPct: number | null;
  elapsedPct: number | null;
  renews: string | null;
  usedHours: number;
  hoursLeft: number | null;
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
  hasBilling: boolean;
  lastBilledOn: string | null;
  insightsVisible: boolean;
};

type DecisionFilter = IndividualAttentionView;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LOCKED_COLUMNS: ReadonlySet<string> = new Set(["name"]);
const DEFAULT_HIDDEN_COLUMNS = ["used", "weekly", "billedHours", "transactions", "billedAmount"];
const DEFAULT_SORT: SortState = [{ key: "renews", dir: "asc" }];

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
  return row.insightsVisible && isActiveBillingWithoutBudget(row);
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
    || row.budget?.expired === true
    || row.budget?.status === "near_exhaustion"
    || row.budget?.status === "fully_used";
}

function matchesFilter(row: IndividualRow, filter: DecisionFilter): boolean {
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

function SummaryMetric({ icon: Icon, label, value, tone = "default" }: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: "default" | "attention" | "success";
}) {
  const toneClass = tone === "attention"
    ? "text-[var(--color-warn)]"
    : tone === "success"
      ? "text-[var(--color-success)]"
      : "text-[var(--color-primary)]";
  return (
    <div className="flex min-w-0 items-center gap-3 py-3">
      <Icon size={18} className={`shrink-0 ${toneClass}`} strokeWidth={1.8} aria-hidden />
      <dl className="min-w-0">
        <dt className="truncate text-xs font-medium text-[var(--color-ink-soft)]">{label}</dt>
        <dd className="tnum mt-0.5 text-lg font-semibold leading-none text-[var(--color-ink)]">{value}</dd>
      </dl>
    </div>
  );
}

function StatusPill({ status }: { status: BudgetLineStatus }) {
  const presentation = BUDGET_STATUS_PRESENT[status];
  return (
    <span className="badge" style={{ background: presentation.tint, color: presentation.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: presentation.color }} />
      {presentation.label}
    </span>
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
      {detail ? <p className="mt-0.5 text-xs font-medium">{detail}</p> : null}
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
        <StatusPill status={row.budget.plainStatus} />
        <PaceBar budget={row.budget} />
      </Link>
    );
  }
  if (row.hasBilling) {
    return (
      <Link href={individualBudgetHref(row.id)} className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-warn)] underline-offset-2 hover:underline">
        <ReceiptText size={14} aria-hidden /> Billing without budget
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-ink-faint)]">
      <Clock3 size={14} aria-hidden /> No activity
    </span>
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
}: {
  rows: IndividualRow[];
  initialFilter?: DecisionFilter;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const [filter, setFilter] = useState<DecisionFilter>(initialFilter);

  const activeRows = useMemo(
    () => rows.filter((row) => row.status === "active" && !row.archived),
    [rows],
  );
  const hasPortfolioVisibility = rows.some((row) => row.insightsVisible);
  const counts = useMemo(() => ({
    all: activeRows.length,
    attention: activeRows.filter(needsAttention).length,
    over: activeRows.filter(isOver).length,
    at_limit: activeRows.filter(isAtLimit).length,
    behind: activeRows.filter(isBehind).length,
    renewing: activeRows.filter(isRenewing).length,
    billing_without_budget: activeRows.filter(hasBillingWithoutBudget).length,
    no_activity: activeRows.filter(hasNoActivity).length,
  }), [activeRows]);
  const monthlyHoursNeeded = useMemo(
    () => activeRows.reduce((sum, row) => sum.plus(row.budget?.mustUseMonthly ?? 0), dec(0)).toString(),
    [activeRows],
  );

  const filterOptions = useMemo(() => {
    const options: Array<{ key: DecisionFilter; label: string; icon: LucideIcon }> = [
      { key: "all", label: "All active", icon: Users },
    ];
    if (hasPortfolioVisibility) {
      options.push(
        { key: "attention", label: "Needs attention", icon: AlertTriangle },
        { key: "at_limit", label: "At or over limit", icon: Gauge },
        { key: "over", label: "Over authorization", icon: Gauge },
        { key: "behind", label: "Behind pace", icon: ArrowDown },
        { key: "renewing", label: "Renewing soon", icon: CalendarClock },
        { key: "billing_without_budget", label: "Billing without budget", icon: ReceiptText },
        { key: "no_activity", label: "No activity", icon: Clock3 },
      );
    }
    return options;
  }, [hasPortfolioVisibility]);

  const portfolioRows = useMemo(
    () => rows
      .filter((row) => (showInactive ? true : row.status === "active" && !row.archived))
      .filter((row) => matchesFilter(row, filter)),
    [filter, rows, showInactive],
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
      key: "renews", label: "Renewal", kind: "date", width: 140,
      accessor: (row) => row.budget?.renews ?? "9999-12-31",
      render: (row) => row.budget ? <Link href={individualBudgetHref(row.id)} className="block underline-offset-2 hover:underline"><Renewal budget={row.budget} /></Link> : <span className="text-[var(--color-ink-faint)]">-</span>,
    },
    {
      key: "health", label: "Budget health", kind: "int", width: 170,
      accessor: (row) => String(healthRank(row)),
      render: (row) => <HealthCell row={row} />,
    },
    {
      key: "left", label: "Hours remaining", kind: "hours", align: "right", width: 125,
      accessor: (row) => row.budget?.hoursLeft?.toString() ?? null,
      render: (row) => row.budget ? <span className={`tnum font-medium ${isOver(row) ? "text-[var(--color-danger)]" : ""}`}>{remainingHours(row.budget)}</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
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
      key: "programs", label: "Programs", kind: "text", width: 180,
      accessor: (row) => row.programs.join(", ") || null,
      render: (row) => <span className="text-[var(--color-ink-soft)]">{row.programs.length ? row.programs.join(", ") : "-"}</span>,
    },
    {
      key: "status", label: "Status", kind: "badge", width: 95,
      accessor: (row) => row.status,
      render: (row) => <Badge value={row.status} />,
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
    {
      key: "billedHours", label: "Billed this period", kind: "hours", align: "right", width: 135,
      accessor: (row) => row.budget?.usedHours.toString() ?? null,
      render: (row) => row.budget ? <span className="tnum font-medium">{formatHours(row.budget.usedHours)} h</span> : <span className="text-[var(--color-ink-faint)]">-</span>,
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

  const grid = useGrid<IndividualRow>({
    rows: portfolioRows,
    columns,
    gridKey: "individual-budget-portfolio",
    canManage: false,
    initialSort: DEFAULT_SORT,
    initialHidden: DEFAULT_HIDDEN_COLUMNS,
    searchKeys: ["name", "programs"],
    serializeHidden: true,
  });

  const inactiveCount = rows.filter((row) => row.status !== "active" || row.archived).length;
  const hasActiveFilters = grid.search.trim().length > 0 || filter !== "all";
  const chooseFilter = (next: DecisionFilter) => {
    setFilter(next);
    if (typeof window !== "undefined") window.history.replaceState(null, "", individualPortfolioHref(next));
  };
  const resetFilters = () => {
    grid.setSearch("");
    chooseFilter("all");
  };

  return (
    <div className="space-y-4">
      <section aria-label="Individual budget portfolio summary" className="border-y border-[var(--color-rule-strong)]">
        <div className="grid grid-cols-2 gap-x-5 sm:grid-cols-3 xl:grid-cols-6">
          <SummaryMetric icon={Users} label="Active individuals" value={activeRows.length.toLocaleString()} />
          {hasPortfolioVisibility ? (
            <>
              <SummaryMetric icon={AlertTriangle} label="Needs attention" value={counts.attention.toLocaleString()} tone={counts.attention > 0 ? "attention" : "success"} />
              <SummaryMetric icon={Gauge} label="Over authorization" value={counts.over.toLocaleString()} tone={counts.over > 0 ? "attention" : "success"} />
              <SummaryMetric icon={Activity} label="Behind pace" value={counts.behind.toLocaleString()} tone={counts.behind > 0 ? "attention" : "success"} />
              <SummaryMetric icon={CalendarClock} label="Renewing in 60 days" value={counts.renewing.toLocaleString()} />
              <SummaryMetric icon={Clock3} label="Monthly hours needed" value={`${formatHours(monthlyHoursNeeded)} h`} />
            </>
          ) : null}
        </div>
      </section>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-72 max-w-full">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)]" aria-hidden />
            <input
              value={grid.search}
              onChange={(event) => grid.setSearch(event.target.value)}
              placeholder="Search individuals or programs"
              className="input input-leading-icon input-trailing-action w-full"
              aria-label="Search individuals"
            />
            {grid.search ? (
              <button
                type="button"
                onClick={() => grid.setSearch("")}
                className="btn btn-sm btn-icon btn-ghost absolute right-0 top-1/2 -translate-y-1/2"
                aria-label="Clear individual search"
                title="Clear search"
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </div>
          <ColumnChooser grid={grid} lockedKeys={LOCKED_COLUMNS} />
          {inactiveCount > 0 ? (
            <label className="flex min-h-9 items-center gap-2 text-sm text-[var(--color-ink-soft)]">
              <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
              Show inactive ({inactiveCount})
            </label>
          ) : null}
          <span className="ml-auto text-sm text-[var(--color-text-soft)]" aria-live="polite">
            <span className="tnum font-semibold text-[var(--color-ink)]">{grid.resultCount}</span>{" "}
            {grid.resultCount === 1 ? "person" : "people"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter individuals by budget decision">
          {filterOptions.map(({ key, label, icon: Icon }) => {
            const selected = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => chooseFilter(key)}
                aria-pressed={selected}
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors sm:min-h-9 ${
                  selected
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                    : "border-[var(--color-rule-strong)] bg-[var(--color-surface)] text-[var(--color-ink-soft)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                }`}
              >
                <Icon size={13} aria-hidden />
                {label}
                <span className={selected ? "text-white/75" : "text-[var(--color-ink-faint)]"}>{counts[key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="scroll-thin max-h-[62vh] overflow-auto rounded-md border border-[var(--color-rule-strong)]">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              {grid.visibleColumns.map((column) => (
                <SortHead key={column.key} column={column} sort={grid.sort} onSort={grid.toggleSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.sorted.map((row) => (
              <tr key={row.id} className={`border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)] ${row.archived ? "opacity-70" : ""}`}>
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
                <td colSpan={Math.max(1, grid.visibleColumns.length)} className="px-3 py-12 text-center text-[var(--color-text-soft)]">
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

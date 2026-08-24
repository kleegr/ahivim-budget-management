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
import { BUDGET_STATUS_PRESENT, type BudgetLineStatus } from "@/lib/business/budget-status";
import { dec, formatHours } from "@/lib/money";

export type IndividualBudget = {
  status: UtilizationStatus;
  plainStatus: BudgetLineStatus;
  usedPct: number | null;
  elapsedPct: number | null;
  renews: string | null;
  hoursLeft: number | null;
  plans: number;
  daysToRenewal: number | null;
  expired: boolean;
  mustUseWeekly: number | null;
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
  insightsVisible: boolean;
};

type DecisionFilter = "all" | "attention" | "over" | "behind" | "renewing" | "billing_without_budget" | "no_activity";
type SortKey = "name" | "programs" | "health" | "used" | "left" | "weekly" | "renews" | "status";
type SortState = { key: SortKey; dir: "asc" | "desc" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}

function isOver(row: IndividualRow): boolean {
  return row.insightsVisible && (
    row.budget?.status === "over_authorization"
    || row.budget?.plainStatus === "over"
  );
}

function isBehind(row: IndividualRow): boolean {
  return row.insightsVisible && row.budget?.status === "behind_pace";
}

function isRenewing(row: IndividualRow): boolean {
  const days = row.budget?.daysToRenewal;
  return row.insightsVisible && days !== null && days !== undefined && days >= 0 && days <= 60;
}

function hasBillingWithoutBudget(row: IndividualRow): boolean {
  return row.insightsVisible && row.hasBilling && row.budget === null;
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
  if (filter === "behind") return row.status === "active" && isBehind(row);
  if (filter === "renewing") return row.status === "active" && isRenewing(row);
  if (filter === "billing_without_budget") return row.status === "active" && hasBillingWithoutBudget(row);
  if (filter === "no_activity") return row.status === "active" && hasNoActivity(row);
  return true;
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
  const used = Math.max(0, Math.min(100, budget.usedPct ?? 0));
  const color = BUDGET_STATUS_PRESENT[budget.plainStatus].color;
  return (
    <div
      className="pace-track mt-1.5"
      role="img"
      aria-label={`${Math.round(used)}% of budget hours used`}
      title={budget.elapsedPct !== null
        ? `${Math.round(used)}% used; ${Math.round(budget.elapsedPct)}% of the budget period elapsed`
        : `${Math.round(used)}% of hours used`}
    >
      <div className="pace-fill" style={{ width: `${used}%`, background: color }} />
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
      <p className="tnum whitespace-nowrap">{formatDate(budget.renews)}</p>
      {detail ? <p className="mt-0.5 text-xs font-medium">{detail}</p> : null}
    </div>
  );
}

function remainingHours(budget: IndividualBudget): string {
  if (budget.hoursLeft === null) return "-";
  if (budget.hoursLeft < 0) return `${formatHours(Math.abs(budget.hoursLeft))} h over`;
  return `${formatHours(budget.hoursLeft)} h`;
}

function requiredWeekly(budget: IndividualBudget): string {
  if (budget.expired && (budget.hoursLeft ?? 0) > 0) return "Past renewal";
  if (budget.daysToRenewal === 0 && (budget.hoursLeft ?? 0) > 0) return "Due now";
  if (budget.mustUseWeekly !== null && budget.mustUseWeekly > 0) {
    return `${formatHours(budget.mustUseWeekly)} h/week`;
  }
  if (budget.hoursLeft !== null && budget.hoursLeft <= 0) return "None";
  return "-";
}

function SortHead({ column, children, align = "left", sort, onSort }: {
  column: SortKey;
  children: string;
  align?: "left" | "right";
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === column;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 font-semibold ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1.5 hover:text-[var(--color-primary)] ${align === "right" ? "flex-row-reverse" : ""}`}
        title={`Sort by ${children}`}
      >
        {children}
        <Icon size={13} className={active ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"} aria-hidden />
      </button>
    </th>
  );
}

export default function IndividualsList({ rows }: { rows: IndividualRow[] }) {
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [filter, setFilter] = useState<DecisionFilter>("all");
  const [sort, setSort] = useState<SortState>({ key: "health", dir: "asc" });

  const activeRows = useMemo(
    () => rows.filter((row) => row.status === "active" && !row.archived),
    [rows],
  );
  const hasPortfolioVisibility = rows.some((row) => row.insightsVisible);
  const counts = useMemo(() => ({
    all: activeRows.length,
    attention: activeRows.filter(needsAttention).length,
    over: activeRows.filter(isOver).length,
    behind: activeRows.filter(isBehind).length,
    renewing: activeRows.filter(isRenewing).length,
    billing_without_budget: activeRows.filter(hasBillingWithoutBudget).length,
    no_activity: activeRows.filter(hasNoActivity).length,
  }), [activeRows]);
  const weeklyHoursNeeded = useMemo(
    () => activeRows.reduce((sum, row) => sum.plus(row.budget?.mustUseWeekly ?? 0), dec(0)).toString(),
    [activeRows],
  );

  const filterOptions = useMemo(() => {
    const options: Array<{ key: DecisionFilter; label: string; icon: LucideIcon }> = [
      { key: "all", label: "All active", icon: Users },
    ];
    if (hasPortfolioVisibility) {
      options.push(
        { key: "attention", label: "Needs attention", icon: AlertTriangle },
        { key: "over", label: "Over authorization", icon: Gauge },
        { key: "behind", label: "Behind pace", icon: ArrowDown },
        { key: "renewing", label: "Renewing soon", icon: CalendarClock },
        { key: "billing_without_budget", label: "Billing without budget", icon: ReceiptText },
        { key: "no_activity", label: "No activity", icon: Clock3 },
      );
    }
    return options;
  }, [hasPortfolioVisibility]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows.filter((row) => (showInactive ? true : row.status === "active" && !row.archived));
    list = list.filter((row) => matchesFilter(row, filter));
    if (needle) {
      list = list.filter((row) => (
        row.name.toLowerCase().includes(needle)
        || (row.preferredName ?? "").toLowerCase().includes(needle)
        || row.programs.some((program) => program.toLowerCase().includes(needle))
      ));
    }

    const healthRank = (row: IndividualRow): number => {
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
    };
    const compare = (a: IndividualRow, b: IndividualRow): number => {
      let difference = 0;
      switch (sort.key) {
        case "name":
          difference = a.name.localeCompare(b.name);
          break;
        case "programs":
          difference = a.programs.join(",").localeCompare(b.programs.join(","));
          break;
        case "health":
          difference = healthRank(a) - healthRank(b);
          break;
        case "used":
          difference = (a.budget?.usedPct ?? -1) - (b.budget?.usedPct ?? -1);
          break;
        case "left":
          difference = (a.budget?.hoursLeft ?? -1) - (b.budget?.hoursLeft ?? -1);
          break;
        case "weekly":
          difference = (a.budget?.mustUseWeekly ?? -1) - (b.budget?.mustUseWeekly ?? -1);
          break;
        case "renews":
          difference = (a.budget?.renews ?? "9999").localeCompare(b.budget?.renews ?? "9999");
          break;
        case "status":
          difference = a.status.localeCompare(b.status);
          break;
      }
      if (difference === 0) difference = a.name.localeCompare(b.name);
      return sort.dir === "asc" ? difference : -difference;
    };
    return list.slice().sort(compare);
  }, [filter, q, rows, showInactive, sort]);

  const inactiveCount = rows.filter((row) => row.status !== "active" || row.archived).length;
  const hasActiveFilters = q.trim().length > 0 || filter !== "all";
  const resetFilters = () => {
    setQ("");
    setFilter("all");
  };
  const toggleSort = (key: SortKey) => {
    setSort((previous) => previous.key === key
      ? { key, dir: previous.dir === "asc" ? "desc" : "asc" }
      : { key, dir: ["used", "left", "weekly"].includes(key) ? "desc" : "asc" });
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
              <SummaryMetric icon={Clock3} label="Weekly hours needed" value={`${formatHours(weeklyHoursNeeded)} h`} />
            </>
          ) : null}
        </div>
      </section>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-72 max-w-full">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)]" aria-hidden />
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search individuals or programs"
              className="input w-full pl-9 pr-9"
              aria-label="Search individuals"
            />
            {q ? (
              <button
                type="button"
                onClick={() => setQ("")}
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                aria-label="Clear individual search"
                title="Clear search"
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </div>
          {inactiveCount > 0 ? (
            <label className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
              <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
              Show inactive ({inactiveCount})
            </label>
          ) : null}
          <span className="ml-auto text-sm text-[var(--color-text-soft)]" aria-live="polite">
            <span className="tnum font-semibold text-[var(--color-ink)]">{visible.length}</span>{" "}
            {visible.length === 1 ? "person" : "people"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter individuals by budget decision">
          {filterOptions.map(({ key, label, icon: Icon }) => {
            const selected = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                aria-pressed={selected}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
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
              <SortHead column="name" sort={sort} onSort={toggleSort}>Individual</SortHead>
              <SortHead column="programs" sort={sort} onSort={toggleSort}>Programs</SortHead>
              <SortHead column="health" sort={sort} onSort={toggleSort}>Budget health</SortHead>
              <SortHead column="used" align="right" sort={sort} onSort={toggleSort}>Used</SortHead>
              <SortHead column="left" align="right" sort={sort} onSort={toggleSort}>Hours remaining</SortHead>
              <SortHead column="weekly" align="right" sort={sort} onSort={toggleSort}>Required weekly</SortHead>
              <SortHead column="renews" sort={sort} onSort={toggleSort}>Renewal</SortHead>
              <SortHead column="status" sort={sort} onSort={toggleSort}>Status</SortHead>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} className={`border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)] ${row.archived ? "opacity-70" : ""}`}>
                <td className="px-3 py-2.5">
                  <Link className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${row.id}`}>
                    {row.name}
                  </Link>
                  {row.preferredName ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Prefers {row.preferredName}</p> : null}
                </td>
                <td className="max-w-56 px-3 py-2.5 text-[var(--color-ink-soft)]">
                  {row.programs.length ? row.programs.join(", ") : <span className="text-[var(--color-ink-faint)]">-</span>}
                </td>
                <td className="min-w-40 px-3 py-2.5">
                  {!row.insightsVisible ? (
                    <span className="text-[var(--color-ink-faint)]">-</span>
                  ) : row.budget ? (
                    <>
                      <StatusPill status={row.budget.plainStatus} />
                      <PaceBar budget={row.budget} />
                    </>
                  ) : row.hasBilling ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-warn)]">
                      <ReceiptText size={14} aria-hidden /> Billing without budget
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-ink-faint)]">
                      <Clock3 size={14} aria-hidden /> No activity
                    </span>
                  )}
                </td>
                <td className="tnum px-3 py-2.5 text-right font-medium">
                  {row.budget?.usedPct === null || row.budget?.usedPct === undefined
                    ? <span className="text-[var(--color-ink-faint)]">-</span>
                    : `${Math.round(row.budget.usedPct)}%`}
                </td>
                <td className={`tnum px-3 py-2.5 text-right font-medium ${isOver(row) ? "text-[var(--color-danger)]" : ""}`}>
                  {row.budget ? remainingHours(row.budget) : <span className="text-[var(--color-ink-faint)]">-</span>}
                </td>
                <td className="tnum px-3 py-2.5 text-right font-medium">
                  {row.budget ? requiredWeekly(row.budget) : <span className="text-[var(--color-ink-faint)]">-</span>}
                </td>
                <td className="px-3 py-2.5">
                  {row.budget ? <Renewal budget={row.budget} /> : <span className="text-[var(--color-ink-faint)]">-</span>}
                </td>
                <td className="px-3 py-2.5"><Badge value={row.status} /></td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-12 text-center text-[var(--color-text-soft)]">
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

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  Clock3,
  Search,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui";
import { ActionButton } from "@/components/manage/client";
import type { EmployeeDealReadiness } from "@/lib/data/employee-directory";
import { dec, formatHours } from "@/lib/money";

export type EmployeeRow = {
  id: string;
  name: string;
  externalRef: string | null;
  status: string;
  archived: boolean;
  transactionCount: number;
  checkCount: number;
  billedHours: string | null;
  individualsServed: number;
  lastActivityDate: string | null;
  dealReadiness: EmployeeDealReadiness | null;
  missingDealTransactions: number | null;
  openSettlementItems: number | null;
};

type DirectoryFilter = "all" | "activity" | "no_activity";
type SortKey = "name" | "activity" | "checks" | "hours" | "status";
type SortState = { key: SortKey; dir: "asc" | "desc" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value: string | null): string {
  if (!value) return "No dated activity";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}

function matchesFilter(row: EmployeeRow, filter: DirectoryFilter): boolean {
  if (filter !== "all" && row.archived) return false;
  if (filter === "activity") return row.transactionCount > 0;
  if (filter === "no_activity") return row.transactionCount === 0;
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

export default function EmployeesList({ rows, canEdit }: { rows: EmployeeRow[]; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<DirectoryFilter>("all");
  const [sort, setSort] = useState<SortState>({ key: "activity", dir: "desc" });

  const activeRows = useMemo(() => rows.filter((row) => !row.archived), [rows]);
  const canSeeHours = rows.some((row) => row.billedHours !== null);

  const counts = useMemo(() => ({
    all: activeRows.length,
    activity: activeRows.filter((row) => row.transactionCount > 0).length,
    no_activity: activeRows.filter((row) => row.transactionCount === 0).length,
  }), [activeRows]);

  const totals = useMemo(() => ({
    transactions: activeRows.reduce((sum, row) => sum + row.transactionCount, 0),
    checks: activeRows.reduce((sum, row) => sum + row.checkCount, 0),
    billedHours: activeRows.reduce((sum, row) => sum.plus(row.billedHours ?? 0), dec(0)).toString(),
  }), [activeRows]);

  const filterOptions = useMemo(() => {
    const options: Array<{ key: DirectoryFilter; label: string; icon: LucideIcon }> = [
      { key: "all", label: "All", icon: Users },
    ];
    options.push(
      { key: "activity", label: "Has activity", icon: Activity },
      { key: "no_activity", label: "No activity", icon: Clock3 },
    );
    return options;
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows.filter((row) => (showArchived ? true : !row.archived));
    list = list.filter((row) => matchesFilter(row, filter));
    if (needle) {
      list = list.filter((row) => [
        row.name,
        row.externalRef,
        row.status,
        row.lastActivityDate,
      ].some((value) => value?.toLowerCase().includes(needle)));
    }

    const compare = (a: EmployeeRow, b: EmployeeRow): number => {
      let difference = 0;
      switch (sort.key) {
        case "name":
          difference = a.name.localeCompare(b.name);
          break;
        case "activity":
          difference = a.transactionCount - b.transactionCount;
          break;
        case "checks":
          difference = a.checkCount - b.checkCount;
          break;
        case "hours":
          difference = dec(a.billedHours ?? 0).comparedTo(dec(b.billedHours ?? 0));
          break;
        case "status":
          difference = a.status.localeCompare(b.status);
          break;
      }
      if (difference === 0) difference = a.name.localeCompare(b.name);
      return sort.dir === "asc" ? difference : -difference;
    };
    return list.slice().sort(compare);
  }, [filter, q, rows, showArchived, sort]);

  const archivedCount = rows.filter((row) => row.archived).length;
  const hasActiveFilters = q.trim().length > 0 || filter !== "all";
  const resetFilters = () => {
    setQ("");
    setFilter("all");
  };
  const toggleSort = (key: SortKey) => {
    setSort((previous) => previous.key === key
      ? { key, dir: previous.dir === "asc" ? "desc" : "asc" }
      : { key, dir: ["activity", "checks", "hours"].includes(key) ? "desc" : "asc" });
  };

  const tableColumnCount = 4
    + (canSeeHours ? 1 : 0)
    + (canEdit ? 1 : 0);

  return (
    <div className="space-y-4">
      <section aria-label="Employee portfolio summary" className="border-y border-[var(--color-rule-strong)]">
        <div className="grid grid-cols-2 gap-x-5 sm:grid-cols-4">
          <SummaryMetric icon={Users} label="Active employees" value={activeRows.length.toLocaleString()} />
          <SummaryMetric icon={Activity} label="Billing records" value={totals.transactions.toLocaleString()} />
          <SummaryMetric icon={CalendarDays} label="Pay periods" value={totals.checks.toLocaleString()} />
          {canSeeHours ? <SummaryMetric icon={Clock3} label="Billed hours" value={formatHours(totals.billedHours)} /> : null}
        </div>
      </section>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-72 max-w-full">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)]" aria-hidden />
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search employees or references"
              className="input input-leading-icon input-trailing-action w-full"
              aria-label="Search employees"
            />
            {q ? (
              <button
                type="button"
                onClick={() => setQ("")}
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                aria-label="Clear employee search"
                title="Clear search"
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </div>
          {archivedCount > 0 ? (
            <label className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              Show archived ({archivedCount})
            </label>
          ) : null}
          <span className="ml-auto text-sm text-[var(--color-text-soft)]" aria-live="polite">
            <span className="tnum font-semibold text-[var(--color-ink)]">{visible.length}</span>{" "}
            {visible.length === 1 ? "employee" : "employees"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter employees">
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
        <table className="touch-table w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <SortHead column="name" sort={sort} onSort={toggleSort}>Employee</SortHead>
              <SortHead column="activity" sort={sort} onSort={toggleSort}>Service activity</SortHead>
              <SortHead column="checks" sort={sort} onSort={toggleSort}>Checks / periods</SortHead>
              {canSeeHours ? <SortHead column="hours" align="right" sort={sort} onSort={toggleSort}>Billed hours</SortHead> : null}
              <SortHead column="status" sort={sort} onSort={toggleSort}>Status</SortHead>
              {canEdit ? (
                <th className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold">
                  Actions
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} className={`border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)] ${row.archived ? "opacity-70" : ""}`}>
                <td className="px-3 py-2.5">
                  <Link className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/employees/${row.id}`}>
                    {row.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                    {row.externalRef ? `Reference ${row.externalRef}` : "No payroll reference"}
                  </p>
                </td>
                <td className="px-3 py-2.5">
                  {row.transactionCount > 0 ? (
                    <>
                      <p className="tnum font-medium text-[var(--color-ink)]">
                        {row.transactionCount.toLocaleString()} {row.transactionCount === 1 ? "transaction" : "transactions"}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                        {row.individualsServed.toLocaleString()} {row.individualsServed === 1 ? "person" : "people"} served
                      </p>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[var(--color-ink-faint)]">
                      <Clock3 size={14} aria-hidden /> No activity
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <p className="tnum font-medium text-[var(--color-ink)]">
                    {row.checkCount.toLocaleString()} {row.checkCount === 1 ? "check / period" : "checks / periods"}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                    {row.lastActivityDate ? `Latest ${formatDate(row.lastActivityDate)}` : "No dated activity"}
                  </p>
                </td>
                {canSeeHours ? (
                  <td className="tnum px-3 py-2.5 text-right font-medium">
                    {row.billedHours === null ? <span className="text-[var(--color-ink-faint)]">-</span> : `${formatHours(row.billedHours)} h`}
                  </td>
                ) : null}
                <td className="px-3 py-2.5"><Badge value={row.status} /></td>
                {canEdit ? (
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {row.archived ? (
                      <ActionButton label="Restore" endpoint={`/api/employees/${row.id}`} body={{ action: "restore" }} withReason />
                    ) : (
                      <ActionButton label="Archive" endpoint={`/api/employees/${row.id}`} body={{ action: "archive" }} withReason />
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={tableColumnCount} className="px-3 py-12 text-center text-[var(--color-text-soft)]">
                  <p>{rows.length === 0 ? "No employees yet." : "No employees match these filters."}</p>
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

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, Clock3, Search, UserRoundCheck, Users, X } from "lucide-react";
import { Badge } from "@/components/ui";
import type { PlanningEmployeeDirectoryRow } from "@/lib/data/employee-directory";
import { dec, formatHours } from "@/lib/money";

function dateLabel(value: string | null): string {
  if (!value) return "Nothing scheduled";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${month}/${day}/${year}` : value;
}

export default function PlanningEmployeesList({
  rows,
}: {
  rows: PlanningEmployeeDirectoryRow[];
}) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const activeRows = useMemo(() => rows.filter((row) => row.archivedAt === null), [rows]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows
      .filter((row) => showArchived || row.archivedAt === null)
      .filter((row) => !needle || row.displayName.toLowerCase().includes(needle))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [query, rows, showArchived]);
  const totals = useMemo(() => ({
    assignments: activeRows.reduce((sum, row) => sum + row.activeAssignments, 0),
    scheduledHours: activeRows.reduce((sum, row) => sum.plus(row.pendingHours), dec(0)).toString(),
    availabilitySet: activeRows.filter((row) => row.weeklyAvailabilityWindows > 0).length,
  }), [activeRows]);
  const archivedCount = rows.length - activeRows.length;

  return (
    <div className="space-y-4">
      <section aria-label="Staffing summary" className="border-y border-[var(--color-rule-strong)]">
        <div className="grid grid-cols-2 gap-x-5 sm:grid-cols-4">
          <Summary icon={Users} label="Active employees" value={activeRows.length.toLocaleString()} />
          <Summary icon={UserRoundCheck} label="Active assignments" value={totals.assignments.toLocaleString()} />
          <Summary icon={Clock3} label="Hours scheduled" value={formatHours(totals.scheduledHours)} />
          <Summary icon={CalendarDays} label="Availability set" value={`${totals.availabilitySet}/${activeRows.length}`} />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72 max-w-full">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search employees"
            className="input input-leading-icon input-trailing-action w-full"
            aria-label="Search employees"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-strong)]"
              aria-label="Clear employee search"
              title="Clear search"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {archivedCount > 0 ? (
          <label className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            Show archived ({archivedCount})
          </label>
        ) : null}
        <span className="ml-auto text-sm text-[var(--color-ink-soft)]">
          <span className="tnum font-semibold text-[var(--color-ink)]">{visible.length}</span> {visible.length === 1 ? "employee" : "employees"}
        </span>
      </div>

      <div className="scroll-thin max-h-[62vh] overflow-auto rounded-md border border-[var(--color-rule-strong)]">
        <table className="touch-table w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-[var(--color-surface-strong)] text-left">
            <tr>
              <th className="border-b border-[var(--color-rule-strong)] px-3 py-2 font-semibold">Employee</th>
              <th className="border-b border-[var(--color-rule-strong)] px-3 py-2 font-semibold">Assignments</th>
              <th className="border-b border-[var(--color-rule-strong)] px-3 py-2 font-semibold">Upcoming schedule</th>
              <th className="border-b border-[var(--color-rule-strong)] px-3 py-2 font-semibold">Availability</th>
              <th className="border-b border-[var(--color-rule-strong)] px-3 py-2 font-semibold">Status</th>
              <th className="border-b border-[var(--color-rule-strong)] px-3 py-2 text-right font-semibold">Open</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} className={`border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)] ${row.archivedAt ? "opacity-70" : ""}`}>
                <td className="px-3 py-2.5">
                  <Link className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/employees/${row.id}`}>
                    {row.displayName}
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <p className="tnum font-medium">{row.activeAssignments} active</p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{row.assignedIndividuals} {row.assignedIndividuals === 1 ? "person" : "people"}</p>
                </td>
                <td className="px-3 py-2.5">
                  <p className="tnum font-medium">{formatHours(row.pendingHours)} h</p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{row.pendingSessions} sessions, next {dateLabel(row.nextSessionDate)}</p>
                </td>
                <td className="px-3 py-2.5">
                  <p className="tnum font-medium">{row.weeklyAvailabilityWindows} weekly windows</p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{row.upcomingTimeOff} upcoming time-off entries</p>
                </td>
                <td className="px-3 py-2.5"><Badge value={row.status} /></td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right">
                  <Link
                    href={`/schedule?view=calendar&employeeId=${row.id}`}
                    className="btn btn-sm btn-secondary inline-flex items-center gap-1.5"
                  >
                    <CalendarDays aria-hidden className="h-3.5 w-3.5" />
                    Schedule
                  </Link>
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-12 text-center text-[var(--color-ink-soft)]">No employees match this view.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-3">
      <Icon aria-hidden className="h-[1.1rem] w-[1.1rem] shrink-0 text-[var(--color-primary)]" />
      <dl className="min-w-0">
        <dt className="truncate text-xs font-medium text-[var(--color-ink-soft)]">{label}</dt>
        <dd className="tnum mt-0.5 text-lg font-semibold leading-none">{value}</dd>
      </dl>
    </div>
  );
}

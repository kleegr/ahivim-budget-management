"use client";

import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCircle2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { PlanningCoverageRow } from "@/lib/data/planning-queries";
import { formatHours } from "@/lib/money";

const STATUS = {
  over_committed: {
    label: "Over budget",
    className: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
    icon: AlertTriangle,
  },
  plan_gap: {
    label: "Behind plan",
    className: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
    icon: AlertTriangle,
  },
  covered: {
    label: "Covered by schedule",
    className: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
    icon: CalendarClock,
  },
  on_pace: {
    label: "On track",
    className: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    icon: CheckCircle2,
  },
} as const;

export default function BudgetCoveragePanel({ rows }: { rows: PlanningCoverageRow[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | PlanningCoverageRow["status"]>("all");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => (
      (status === "all" || row.status === status)
      && (!needle || `${row.individualName} ${row.programName} ${row.programCode}`.toLocaleLowerCase().includes(needle))
    ));
  }, [query, rows, status]);
  const needsAttention = rows.filter((row) => row.status === "over_committed" || row.status === "plan_gap").length;
  const scheduled = rows.filter((row) => row.status === "covered").length;
  const onTrack = rows.filter((row) => row.status === "on_pace").length;

  return (
    <section aria-labelledby="budget-coverage-heading">
      <div className="mb-4">
        <h2 id="budget-coverage-heading" className="display text-base font-semibold">Budget tracking</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Authorized, used, scheduled, and still-unplanned hours for every active person and program.
        </p>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] sm:grid-cols-4 sm:divide-y-0">
        <Summary label="Active budgets" value={rows.length} />
        <Summary label="Needs attention" value={needsAttention} tone={needsAttention > 0 ? "warn" : undefined} />
        <Summary label="Covered by schedule" value={scheduled} />
        <Summary label="On track" value={onTrack} tone="good" />
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 text-xs font-semibold text-[var(--color-ink-soft)]">
          Find a person or program
          <span className="relative mt-1 block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
            <input
              type="search"
              className="input min-h-10 w-full pl-9 text-sm font-normal"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
            />
          </span>
        </label>
        <label className="min-w-52 text-xs font-semibold text-[var(--color-ink-soft)]">
          Status
          <select
            className="input mt-1 min-h-10 w-full text-sm font-normal"
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="all">All statuses</option>
            <option value="plan_gap">Behind plan</option>
            <option value="over_committed">Over budget</option>
            <option value="covered">Covered by schedule</option>
            <option value="on_pace">On track</option>
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-5 border-y border-[var(--color-rule)] py-8 text-center text-sm text-[var(--color-ink-soft)]">
          No active budgets match this view.
        </p>
      ) : (
        <div className="scroll-thin mt-4 overflow-x-auto border-y border-[var(--color-rule-strong)]">
          <table className="w-full min-w-[1040px] text-sm">
            <thead className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-left text-xs font-semibold text-[var(--color-ink-soft)]">
              <tr>
                <th className="px-3 py-2.5">Person</th>
                <th className="px-3 py-2.5">Program</th>
                <th className="px-3 py-2.5">Budget period</th>
                <th className="px-3 py-2.5 text-right">Authorized</th>
                <th className="px-3 py-2.5 text-right">Used</th>
                <th className="px-3 py-2.5 text-right">Scheduled</th>
                <th className="px-3 py-2.5 text-right">Still to plan</th>
                <th className="px-3 py-2.5 text-right">Needed / week</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-rule)]">
              {filtered.map((row) => {
                const statusMeta = STATUS[row.status];
                const Icon = statusMeta.icon;
                return (
                  <tr key={row.authorizationId}>
                    <td className="px-3 py-3 font-medium text-[var(--color-ink)]">{row.individualName}</td>
                    <td className="px-3 py-3 text-[var(--color-ink-soft)]">{row.programName}</td>
                    <td className="px-3 py-3 text-xs text-[var(--color-ink-soft)]">
                      <span className="block font-medium text-[var(--color-ink)]">{row.periodLabel}</span>
                      <span>{row.startDate} to {row.endDate}</span>
                    </td>
                    <NumberCell value={row.authorizedHours} />
                    <NumberCell value={row.actualHours} />
                    <NumberCell value={row.scheduledHours} />
                    <NumberCell value={row.unplannedHours} emphasis />
                    <td className="tnum px-3 py-3 text-right">
                      {row.requiredWeeklyHours === null ? "-" : formatHours(row.requiredWeeklyHours)}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ${statusMeta.className}`}>
                        <Icon aria-hidden className="h-3.5 w-3.5" />{statusMeta.label}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Link
                        href={`/schedule?view=calendar&individualId=${row.individualId}&date=${row.nextScheduledDate ?? row.startDate}`}
                        className="btn btn-secondary btn-sm"
                      >
                        Plan
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone?: "warn" | "good" }) {
  const color = tone === "warn"
    ? "text-[var(--color-warn)]"
    : tone === "good"
      ? "text-[var(--color-success)]"
      : "text-[var(--color-ink)]";
  return (
    <div className="min-h-20 px-3 py-3">
      <p className={`tnum text-xl font-semibold ${color}`}>{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{label}</p>
    </div>
  );
}

function NumberCell({ value, emphasis = false }: { value: string; emphasis?: boolean }) {
  return (
    <td className={`tnum px-3 py-3 text-right ${emphasis ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-ink-soft)]"}`}>
      {formatHours(value)}
    </td>
  );
}

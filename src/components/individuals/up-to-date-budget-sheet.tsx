"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, History, Search } from "lucide-react";
import { Card, EmptyState, StatusBadge } from "@/components/ui";
import {
  matchesUpToDatePeriod,
  sumUpToDatePeriods,
  type UpToDateBudgetPortfolio,
  type UpToDatePeriodRow,
  type UpToDateProgramColumn,
} from "@/lib/business/up-to-date-budget";
import { dec, formatHours } from "@/lib/money";
import { individualBudgetHref } from "@/lib/nav/review-actions";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateLabel(value: string | null): string {
  if (!value) return "Not set";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}

function HoursValue({ value, emphasize = false }: { value: string; emphasize?: boolean }) {
  const negative = dec(value).isNegative();
  return (
    <span className={`tnum whitespace-nowrap ${emphasize ? "font-semibold" : ""} ${negative ? "text-[var(--color-danger)]" : ""}`}>
      {formatHours(value)}
    </span>
  );
}

function BlankCell() {
  return <span className="text-[var(--color-ink-faint)]">—</span>;
}

function PeriodRows({
  rows,
  programs,
}: {
  rows: readonly UpToDatePeriodRow[];
  programs: readonly UpToDateProgramColumn[];
}) {
  return rows.map((row) => (
    <tr key={row.id} className="border-b border-[var(--color-rule)] align-top last:border-0 hover:bg-[var(--color-surface-muted)]">
      <th scope="row" className="min-w-52 px-4 py-3 text-left font-normal">
        <Link className="font-semibold text-[var(--color-primary)] hover:underline" href={individualBudgetHref(row.individualId)}>
          {row.individualName}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <StatusBadge
            tone={row.kind === "current" ? "good" : row.kind === "upcoming" ? "info" : "muted"}
            label={row.kind === "current" ? "Current" : row.kind === "upcoming" ? "Upcoming" : "Historical"}
          />
          {row.hasUndatedUsage ? (
            <span title="Some billed usage needs a service date before it can count toward this period.">
              <AlertTriangle aria-label="Usage missing a service date" className="h-4 w-4 text-[var(--color-warn)]" />
            </span>
          ) : null}
          {row.hasDuplicateSource ? (
            <span className="text-xs font-semibold text-[var(--color-warn)]" title="The canonical selector chose one of multiple financial-plan sources.">
              Source review
            </span>
          ) : null}
        </div>
      </th>
      <td className="min-w-56 px-4 py-3">
        <p className="font-medium text-[var(--color-ink)]">{row.periodLabel}</p>
        <p className="tnum mt-1 whitespace-nowrap text-xs text-[var(--color-ink-faint)]">
          {dateLabel(row.startDate)} – {dateLabel(row.endDate)}
        </p>
      </td>
      <td className="min-w-36 px-4 py-3">
        <p className={`tnum whitespace-nowrap ${row.renewalDate ? "" : "font-semibold text-[var(--color-danger)]"}`}>
          {dateLabel(row.renewalDate)}
        </p>
        <p className="mt-1 text-xs capitalize text-[var(--color-ink-faint)]">{row.periodStatus.replace(/_/g, " ")}</p>
      </td>
      {programs.flatMap((program) => {
        const balance = row.programs[program.id];
        return [
          <td key={`${program.id}:billed`} className="px-3 py-3 text-right">
            {balance ? <HoursValue value={balance.billedHours} /> : <BlankCell />}
          </td>,
          <td key={`${program.id}:original`} className="px-3 py-3 text-right">
            {balance ? <HoursValue value={balance.originalHours} /> : <BlankCell />}
          </td>,
          <td key={`${program.id}:left`} className="border-r border-[var(--color-rule-strong)] px-3 py-3 text-right">
            {balance ? <HoursValue value={balance.whatsLeftHours} emphasize /> : <BlankCell />}
          </td>,
        ];
      })}
      <td className="px-3 py-3 text-right"><HoursValue value={row.billedHours} /></td>
      <td className="px-3 py-3 text-right"><HoursValue value={row.originalHours} /></td>
      <td className="px-3 py-3 text-right"><HoursValue value={row.whatsLeftHours} emphasize /></td>
    </tr>
  ));
}

function BudgetPeriodTable({
  rows,
  programs,
  caption,
}: {
  rows: readonly UpToDatePeriodRow[];
  programs: readonly UpToDateProgramColumn[];
  caption: string;
}) {
  return (
    <div
      className="scroll-thin max-h-[70vh] overflow-auto"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table className="touch-table min-w-max border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10">
          <tr className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] text-xs text-[var(--color-ink-soft)]">
            <th scope="col" rowSpan={2} className="px-4 py-2.5 text-left font-semibold">Individual</th>
            <th scope="col" rowSpan={2} className="px-4 py-2.5 text-left font-semibold">Authorization period</th>
            <th scope="col" rowSpan={2} className="px-4 py-2.5 text-left font-semibold">Renewal</th>
            {programs.map((program) => (
              <th key={program.id} scope="colgroup" colSpan={3} className="border-x border-[var(--color-rule-strong)] px-3 py-2.5 text-center font-semibold">
                <span className="block whitespace-nowrap text-[var(--color-ink)]">{program.name}</span>
                <span className="font-normal text-[var(--color-ink-faint)]">{program.code}</span>
              </th>
            ))}
            <th scope="colgroup" colSpan={3} className="px-3 py-2.5 text-center font-semibold text-[var(--color-ink)]">All programs</th>
          </tr>
          <tr className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-soft)]">
            {programs.flatMap((program) => [
              <th key={`${program.id}:billed`} scope="col" className="min-w-20 px-3 py-2 text-right font-semibold" title="Committed usage derived from recorded activity">Billed</th>,
              <th key={`${program.id}:original`} scope="col" className="min-w-20 px-3 py-2 text-right font-semibold" title="Authorized hours for this period">Original</th>,
              <th key={`${program.id}:left`} scope="col" className="min-w-24 border-r border-[var(--color-rule-strong)] px-3 py-2 text-right font-semibold" title="Original minus billed">What&apos;s Left</th>,
            ])}
            <th scope="col" className="min-w-20 px-3 py-2 text-right font-semibold">Billed</th>
            <th scope="col" className="min-w-20 px-3 py-2 text-right font-semibold">Original</th>
            <th scope="col" className="min-w-24 px-3 py-2 text-right font-semibold">What&apos;s Left</th>
          </tr>
        </thead>
        <tbody><PeriodRows rows={rows} programs={programs} /></tbody>
      </table>
    </div>
  );
}

function SummaryMetric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-r border-[var(--color-rule)] px-4 py-3 last:border-r-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</p>
      <p className="tnum mt-1 text-xl font-semibold text-[var(--color-ink)]">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{hint}</p> : null}
    </div>
  );
}

export default function UpToDateBudgetSheet({ portfolio }: { portfolio: UpToDateBudgetPortfolio }) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [programId, setProgramId] = useState("");
  const {
    programs,
    current: currentRows,
    historical: historicalRows,
    upcoming: upcomingRows,
  } = portfolio;
  const current = useMemo(
    () => currentRows.filter((row) => matchesUpToDatePeriod(row, deferredSearch, programId)),
    [currentRows, deferredSearch, programId],
  );
  const historical = useMemo(
    () => historicalRows.filter((row) => matchesUpToDatePeriod(row, deferredSearch, programId)),
    [historicalRows, deferredSearch, programId],
  );
  const upcoming = useMemo(
    () => upcomingRows.filter((row) => matchesUpToDatePeriod(row, deferredSearch, programId)),
    [upcomingRows, deferredSearch, programId],
  );
  const totals = useMemo(() => sumUpToDatePeriods(current), [current]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3 px-4 py-4">
          <label className="min-w-64 flex-1">
            <span className="sr-only">Search authorization periods</span>
            <span className="relative block">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search individual, period, or date"
                className="input w-full pl-9"
              />
            </span>
          </label>
          <label className="min-w-52">
            <span className="mb-1 block text-xs font-semibold text-[var(--color-ink-soft)]">Rows containing program</span>
            <select className="select w-full" value={programId} onChange={(event) => setProgramId(event.target.value)}>
              <option value="">All programs</option>
              {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
            </select>
          </label>
        </div>
        <div className="border-t border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-ink-soft)]">
          <strong className="text-[var(--color-ink)]">Live authorization math:</strong> Billed comes from committed activity, Original is the authorized allowance, and What&apos;s Left is derived from those two values.
        </div>
      </Card>

      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] sm:grid-cols-5">
        <SummaryMetric label="Current periods" value={String(totals.periods)} hint={`${totals.people} people`} />
        <SummaryMetric label="Billed" value={`${formatHours(totals.billedHours)} h`} />
        <SummaryMetric label="Original" value={`${formatHours(totals.originalHours)} h`} />
        <SummaryMetric label="What's Left" value={`${formatHours(totals.whatsLeftHours)} h`} />
        <SummaryMetric label="After schedule" value={`${formatHours(totals.afterScheduledHours)} h`} hint={`${formatHours(totals.scheduledHours)} h pending`} />
      </div>

      <Card
        title="Current authorization periods"
        description={`${current.length} ${current.length === 1 ? "period" : "periods"} in the current filter. Each row keeps its own renewal clock.`}
      >
        {current.length === 0 ? (
          <EmptyState title="No current authorization periods" compact icon={<CalendarClock aria-hidden className="h-5 w-5" />}>
            <p>{currentRows.length === 0 ? "Historical and upcoming periods remain available below." : "Try clearing the search or program filter."}</p>
          </EmptyState>
        ) : (
          <BudgetPeriodTable rows={current} programs={programs} caption="Current authorization balances by individual and program" />
        )}
      </Card>

      {portfolio.historical.length > 0 ? (
        <details className="card overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 font-semibold text-[var(--color-ink)]">
            <History aria-hidden className="h-4 w-4 text-[var(--color-ink-faint)]" />
            Historical authorization periods
            <span className="tnum text-xs font-normal text-[var(--color-ink-faint)]">{historical.length} of {portfolio.historical.length}</span>
          </summary>
          {historical.length === 0 ? (
            <p className="border-t border-[var(--color-rule)] px-5 py-5 text-sm text-[var(--color-ink-faint)]">No historical periods match the current filters.</p>
          ) : (
            <div className="border-t border-[var(--color-rule)]">
              <BudgetPeriodTable rows={historical} programs={programs} caption="Historical authorization balances by individual and program" />
            </div>
          )}
        </details>
      ) : null}

      {portfolio.upcoming.length > 0 ? (
        <details className="card overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 font-semibold text-[var(--color-ink)]">
            <CalendarClock aria-hidden className="h-4 w-4 text-[var(--color-ink-faint)]" />
            Upcoming authorization periods
            <span className="tnum text-xs font-normal text-[var(--color-ink-faint)]">{upcoming.length} of {portfolio.upcoming.length}</span>
          </summary>
          {upcoming.length === 0 ? (
            <p className="border-t border-[var(--color-rule)] px-5 py-5 text-sm text-[var(--color-ink-faint)]">No upcoming periods match the current filters.</p>
          ) : (
            <div className="border-t border-[var(--color-rule)]">
              <BudgetPeriodTable rows={upcoming} programs={programs} caption="Upcoming authorization balances by individual and program" />
            </div>
          )}
        </details>
      ) : null}
    </div>
  );
}

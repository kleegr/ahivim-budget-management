"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import type {
  CalendarSession, SessionWarningFlags, ScheduleUtilizationSummary,
} from "@/lib/data/schedule-queries";
import {
  send, SessionChip, addDays, weekday, startOfWeek, startOfMonth, monthGridStart,
  monthLabel, humanDate, prettyTime, WEEKDAYS, STATUS_LABEL,
  sessionTone, EVENT_TONE_COLOR, EVENT_TONE_LABEL, type EventTone, type SessionFlags,
  type Picker, type ProgramPicker, type View,
} from "./shared";
import SessionDetail from "./session-detail";
import CreateSessionModal from "./create-session-modal";
import { PaceBar } from "@/components/ui";
import { BigStat, ProgressBar, UtilizationBadge } from "@/components/ui-viz";
import { dec, formatHours, formatPercent } from "@/lib/money";

type FlagMap = Map<string, SessionFlags>;
type Perspective = "all" | "employee" | "individual";

export interface ScheduleCalendarProps {
  canManage: boolean;
  today: string; // YYYY-MM-DD, from the server, to avoid timezone drift
  employees: Picker[];
  individuals: Picker[];
  programs: ProgramPicker[];
  initialDate?: string;
  initialView?: View;
  initialFilters?: {
    employeeId?: string;
    individualId?: string;
    programId?: string;
    status?: string;
    unassigned?: boolean;
  };
}

/* ===========================================================================
 * Main component: view switch, navigation, filters, data load, and modals.
 * ========================================================================= */
export default function ScheduleCalendar(props: ScheduleCalendarProps) {
  const {
    canManage, today, employees, individuals, programs,
    initialDate, initialView, initialFilters,
  } = props;
  const startingDate = initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : today;

  const [view, setView] = useState<View>(initialView ?? "month");
  const [anchor, setAnchor] = useState(startingDate);
  const [perspective, setPerspective] = useState<Perspective>(
    initialFilters?.individualId ? "individual" : initialFilters?.employeeId ? "employee" : "all",
  );
  const [filters, setFilters] = useState({
    employeeId: initialFilters?.employeeId ?? "",
    individualId: initialFilters?.individualId ?? "",
    programId: initialFilters?.programId ?? "",
    unassigned: initialFilters?.unassigned ?? false,
    status: initialFilters?.status ?? "",
  });
  const [sessions, setSessions] = useState<CalendarSession[]>([]);
  const [flags, setFlags] = useState<FlagMap>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalendarSession | null>(null);
  const [creating, setCreating] = useState<null | { date: string; mode: "one_time" | "recurring" }>(null);
  const [summary, setSummary] = useState<ScheduleUtilizationSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const loadRequestId = useRef(0);

  const range = useMemo(() => {
    if (view === "day") return { from: anchor, to: anchor };
    if (view === "week") {
      const s = startOfWeek(anchor);
      return { from: s, to: addDays(s, 6) };
    }
    const s = monthGridStart(anchor);
    return { from: s, to: addDays(s, 41) };
  }, [view, anchor]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ from: range.from, to: range.to });
    if (filters.employeeId) qs.set("employeeId", filters.employeeId);
    if (filters.individualId) qs.set("individualId", filters.individualId);
    if (filters.programId) qs.set("programId", filters.programId);
    if (filters.unassigned) qs.set("unassigned", "true");
    if (filters.status) qs.set("status", filters.status);
    const res = await send("GET", `/api/schedule/sessions?${qs.toString()}`);
    if (requestId !== loadRequestId.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? "Could not load the schedule.");
      setSessions([]);
      setFlags(new Map());
      return;
    }
    const data = res.data as { sessions: CalendarSession[]; warningFlags?: SessionWarningFlags[] };
    setSessions(data.sessions ?? []);
    setFlags(new Map<string, SessionFlags>((data.warningFlags ?? []).map((f) => [f.id, f])));
  }, [range, filters]);

  useEffect(() => {
    void load();
    return () => { loadRequestId.current += 1; };
  }, [load]);

  // Utilization strip: load the authorized/used/scheduled/remaining picture for
  // the individual currently in focus. Only meaningful for a single individual.
  useEffect(() => {
    const individualId = filters.individualId;
    if (!individualId) {
      setSummary(null);
      setSummaryLoading(false);
      return;
    }
    let cancelled = false;
    setSummary(null); // avoid showing a prior individual's figures while loading
    setSummaryLoading(true);
    void (async () => {
      const res = await send("GET", `/api/schedule/utilization?individualId=${encodeURIComponent(individualId)}`);
      if (cancelled) return;
      setSummaryLoading(false);
      setSummary(res.ok ? ((res.data as ScheduleUtilizationSummary | null) ?? null) : null);
    })();
    return () => { cancelled = true; };
  }, [filters.individualId]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarSession[]>();
    for (const s of sessions) {
      const arr = map.get(s.sessionDate) ?? [];
      arr.push(s);
      map.set(s.sessionDate, arr);
    }
    return map;
  }, [sessions]);

  const rangeSummary = useMemo(() => {
    let serviceHours = dec(0);
    let budgetHours = dec(0);
    let scheduledSessions = 0;
    let excludedSessions = 0;
    const employeeIds = new Set<string>();
    const individualIds = new Set<string>();
    let flaggedSessions = 0;
    for (const session of sessions) {
      if (session.status === "cancelled" || session.status === "no_show") {
        excludedSessions += 1;
        continue;
      }
      scheduledSessions += 1;
      serviceHours = serviceHours.plus(session.durationHours);
      budgetHours = budgetHours.plus(dec(session.durationHours).times(Math.max(1, session.individualIds.length)));
      if (session.employeeId) employeeIds.add(session.employeeId);
      for (const id of session.individualIds) individualIds.add(id);
      if (session.warningCount > 0) flaggedSessions += 1;
    }
    return {
      sessions: scheduledSessions,
      excludedSessions,
      serviceHours: formatHours(serviceHours),
      budgetHours: formatHours(budgetHours),
      employees: employeeIds.size,
      individuals: individualIds.size,
      flaggedSessions,
    };
  }, [sessions]);

  function step(dir: number) {
    if (view === "day") setAnchor(addDays(anchor, dir));
    else if (view === "week") setAnchor(addDays(anchor, dir * 7));
    else setAnchor(addDays(startOfMonth(anchor), dir > 0 ? 32 : -1));
  }

  function changePerspective(next: Perspective) {
    setPerspective(next);
    setFilters((current) => ({
      ...current,
      employeeId: next === "employee" ? current.employeeId : "",
      individualId: next === "individual" ? current.individualId : "",
      unassigned: next === "all" ? current.unassigned : false,
    }));
  }

  const label = view === "month" ? monthLabel(anchor) : view === "week" ? `Week of ${humanDate(startOfWeek(anchor))}` : humanDate(anchor);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="segmented-control" role="group" aria-label="Calendar view">
          {(["month", "week", "day"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className="capitalize"
            >
              {v}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={() => step(-1)} aria-label="Previous period" title="Previous period" className="btn btn-sm btn-icon btn-ghost"><ChevronLeft aria-hidden className="h-4 w-4" /></button>
          <button type="button" onClick={() => setAnchor(today)} className="btn btn-sm btn-secondary">Today</button>
          <button type="button" onClick={() => step(1)} aria-label="Next period" title="Next period" className="btn btn-sm btn-icon btn-ghost"><ChevronRight aria-hidden className="h-4 w-4" /></button>
        </div>
        <p className="display min-w-0 text-base font-semibold">{label}</p>
        <div className="ml-auto flex items-center gap-2">
          {loading ? <span role="status" className="text-xs text-[var(--color-ink-faint)]">Loading…</span> : null}
          {canManage ? (
            <button
              type="button"
              onClick={() => setCreating({
                date: view === "month" && anchor.slice(0, 7) !== today.slice(0, 7)
                  ? startOfMonth(anchor)
                  : view === "month" ? today : anchor,
                mode: "recurring",
              })}
              className="btn btn-sm btn-primary"
            >
              <Plus aria-hidden className="h-4 w-4" /> New schedule
            </button>
          ) : null}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-y border-[var(--color-rule)] py-3 text-sm">
        <div className="segmented-control" role="group" aria-label="Schedule perspective">
          {(["all", "employee", "individual"] as Perspective[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={perspective === option}
              onClick={() => changePerspective(option)}
            >
              {option === "all" ? "All schedules" : option === "employee" ? "By employee" : "By individual"}
            </button>
          ))}
        </div>
        {perspective === "employee" ? (
          <select aria-label="Choose employee" value={filters.employeeId} onChange={(e) => setFilters((f) => ({ ...f, employeeId: e.target.value, unassigned: false }))} className="select min-w-48">
            <option value="">Choose employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        ) : null}
        {perspective === "individual" ? (
          <select aria-label="Choose individual" value={filters.individualId} onChange={(e) => setFilters((f) => ({ ...f, individualId: e.target.value }))} className="select min-w-48">
            <option value="">Choose individual</option>
            {individuals.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        ) : null}
        <select aria-label="Filter by program" value={filters.programId} onChange={(e) => setFilters((f) => ({ ...f, programId: e.target.value }))} className="select">
          <option value="">All programs</option>
          {programs.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
        </select>
        <select aria-label="Filter by status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="select">
          <option value="">Any status</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="no_show">No-show</option>
        </select>
        {perspective === "all" ? (
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={filters.unassigned} onChange={(e) => setFilters((f) => ({ ...f, unassigned: e.target.checked, employeeId: e.target.checked ? "" : f.employeeId }))} />
            Employee needed
          </label>
        ) : null}
        {(filters.employeeId || filters.individualId || filters.programId || filters.status || filters.unassigned) ? (
          <button type="button" onClick={() => { setPerspective("all"); setFilters({ employeeId: "", individualId: "", programId: "", unassigned: false, status: "" }); }} className="btn btn-sm btn-ghost">
            <X aria-hidden className="h-4 w-4" /> Clear filters
          </button>
        ) : null}
      </div>

      <RangeSummary
        summary={rangeSummary}
        label={
          perspective === "employee" && filters.employeeId
            ? employees.find((employee) => employee.id === filters.employeeId)?.label ?? "Employee"
            : perspective === "individual" && filters.individualId
              ? individuals.find((individual) => individual.id === filters.individualId)?.label ?? "Individual"
              : label
        }
        perspective={perspective}
      />

      {/* Utilization strip: budget headroom for the individual in focus. */}
      {filters.individualId ? (
        <UtilizationStrip summary={summary} loading={summaryLoading} />
      ) : null}

      <CalendarLegend />

      {error ? (
        <div role="alert" className="rounded-lg border border-[var(--color-pace-over)] bg-[#fdf2f5] px-4 py-3 text-sm text-[var(--color-pace-over)]">{error}</div>
      ) : null}

      {view === "month" ? (
        <MonthGrid anchor={anchor} today={today} byDate={byDate} flags={flags} onSelect={setSelected} onAdd={canManage ? (d) => setCreating({ date: d, mode: "one_time" }) : undefined} />
      ) : view === "week" ? (
        <WeekList anchor={anchor} today={today} byDate={byDate} flags={flags} onSelect={setSelected} onAdd={canManage ? (d) => setCreating({ date: d, mode: "one_time" }) : undefined} />
      ) : (
        <DayList date={anchor} today={today} sessions={byDate.get(anchor) ?? []} flags={flags} onSelect={setSelected} onAdd={canManage ? (d) => setCreating({ date: d, mode: "one_time" }) : undefined} />
      )}

      {selected ? (
        <SessionDetail
          session={selected}
          canManage={canManage}
          onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); void load(); }}
        />
      ) : null}

      {creating ? (
        <CreateSessionModal
          defaultDate={creating.date}
          employees={employees}
          individuals={individuals}
          programs={programs}
          initialMode={creating.mode}
          initialEmployeeId={filters.employeeId}
          initialIndividualId={filters.individualId}
          initialProgramId={filters.programId}
          onClose={() => setCreating(null)}
          onCreated={() => { setCreating(null); void load(); }}
        />
      ) : null}
    </div>
  );
}

function RangeSummary({
  summary,
  label,
  perspective,
}: {
  summary: {
    sessions: number;
    excludedSessions: number;
    serviceHours: string;
    budgetHours: string;
    employees: number;
    individuals: number;
    flaggedSessions: number;
  };
  label: string;
  perspective: Perspective;
}) {
  const hours = perspective === "employee" ? summary.serviceHours : summary.budgetHours;
  const items = [
    {
      label: "Sessions",
      value: String(summary.sessions),
      detail: summary.excludedSessions > 0
        ? `${label}; ${summary.excludedSessions} cancelled/no-show excluded`
        : label,
    },
    { label: "Scheduled hours", value: `${hours} h`, detail: perspective === "employee" ? "employee time" : "individual budget hours" },
    { label: "Individuals", value: String(summary.individuals), detail: "receiving service" },
    { label: "Employees", value: String(summary.employees), detail: "scheduled to work" },
    { label: "Needs review", value: String(summary.flaggedSessions), detail: "conflict or budget risk" },
  ];
  return (
    <dl className="grid divide-y divide-[var(--color-rule)] border-b border-[var(--color-rule)] sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 px-3 py-2.5 first:pl-0 last:pr-0">
          <dt className="eyebrow">{item.label}</dt>
          <dd className={`tnum mt-1 text-base font-semibold ${item.label === "Needs review" && summary.flaggedSessions > 0 ? "text-[var(--color-danger)]" : ""}`}>{item.value}</dd>
          <p className="mt-0.5 truncate text-[11px] text-[var(--color-ink-faint)]" title={item.detail}>{item.detail}</p>
        </div>
      ))}
    </dl>
  );
}

/* ===========================================================================
 * Month grid.
 * ========================================================================= */
function MonthGrid({
  anchor, today, byDate, flags, onSelect, onAdd,
}: {
  anchor: string;
  today: string;
  byDate: Map<string, CalendarSession[]>;
  flags: FlagMap;
  onSelect: (s: CalendarSession) => void;
  onAdd?: (date: string) => void;
}) {
  const gridStart = monthGridStart(anchor);
  const month = anchor.slice(0, 7);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  return (
    <div className="scroll-thin overflow-x-auto rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]">
      {/* min-width keeps cells usable on phones; the container scrolls instead of squishing. */}
      <div className="min-w-[680px] sm:min-w-0">
        <div className="grid grid-cols-7 border-b border-[var(--color-rule)] text-xs font-semibold text-[var(--color-ink-faint)]">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5 text-center uppercase">
              <span className="sm:hidden">{w.slice(0, 1)}</span>
              <span className="hidden sm:inline">{w}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d) => {
            const inMonth = d.slice(0, 7) === month;
            const isToday = d === today;
            const list = byDate.get(d) ?? [];
            return (
              <div key={d} className={`min-h-[84px] border-b border-r border-[var(--color-rule)] p-1 sm:min-h-[92px] ${inMonth ? "" : "bg-[var(--color-paper)]"}`}>
                <div className="mb-1 flex items-center justify-between">
                  <span className={`tnum text-xs ${isToday ? "rounded bg-[var(--color-primary)] px-1.5 py-0.5 font-semibold text-white" : inMonth ? "text-[var(--color-ink)]" : "text-[var(--color-ink-faint)]"}`}>
                    {Number(d.slice(8, 10))}
                  </span>
                  {onAdd ? <button type="button" onClick={() => onAdd(d)} aria-label={`Add session on ${d}`} title="Add one-time session" className="btn btn-icon btn-ghost h-6 w-6"><Plus aria-hidden className="h-3.5 w-3.5" /></button> : null}
                </div>
                <div className="space-y-0.5">
                  {list.slice(0, 4).map((s) => <SessionChip key={s.id} s={s} flags={flags.get(s.id)} onSelect={onSelect} />)}
                  {list.length > 4 ? <span className="block px-1 text-[10px] text-[var(--color-ink-faint)]">+{list.length - 4} more</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ===========================================================================
 * Week + day lists.
 * ========================================================================= */
function WeekList({
  anchor, today, byDate, flags, onSelect, onAdd,
}: {
  anchor: string;
  today: string;
  byDate: Map<string, CalendarSession[]>;
  flags: FlagMap;
  onSelect: (s: CalendarSession) => void;
  onAdd?: (date: string) => void;
}) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="grid gap-2 md:grid-cols-7">
      {days.map((d) => (
        <div key={d} className={`rounded-lg border p-2 ${d === today ? "border-[var(--color-primary)]" : "border-[var(--color-rule)]"} bg-[var(--color-surface)]`}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold">{WEEKDAYS[weekday(d)]} {Number(d.slice(8, 10))}</span>
            {onAdd ? <button type="button" onClick={() => onAdd(d)} aria-label={`Add session on ${d}`} title="Add one-time session" className="btn btn-icon btn-ghost h-6 w-6"><Plus aria-hidden className="h-3.5 w-3.5" /></button> : null}
          </div>
          <div className="space-y-1">
            {(byDate.get(d) ?? []).map((s) => <SessionChip key={s.id} s={s} flags={flags.get(s.id)} onSelect={onSelect} />)}
            {(byDate.get(d) ?? []).length === 0 ? <p className="text-[11px] text-[var(--color-ink-faint)]">—</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function DayList({
  date, today, sessions, flags, onSelect, onAdd,
}: {
  date: string;
  today: string;
  sessions: CalendarSession[];
  flags: FlagMap;
  onSelect: (s: CalendarSession) => void;
  onAdd?: (date: string) => void;
}) {
  const sorted = [...sessions].sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] px-3 py-2 sm:px-4">
        <span className="min-w-0 text-sm font-medium">{humanDate(date)}{date === today ? " · today" : ""}</span>
        {onAdd ? <button type="button" onClick={() => onAdd(date)} className="inline-flex min-h-11 shrink-0 items-center rounded border border-[var(--color-rule-strong)] px-3 text-xs">Add session</button> : null}
      </div>
      {sorted.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">Nothing scheduled.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-rule)]">
          {sorted.map((s) => {
            const f = flags.get(s.id);
            const tone = sessionTone(s, f);
            const color = EVENT_TONE_COLOR[tone];
            const flagged = tone === "over_risk" || tone === "flagged";
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s)}
                  className="grid min-h-11 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-l-[3px] px-3 py-3 text-left hover:bg-[var(--color-paper)] sm:grid-cols-[6rem_auto_minmax(0,1fr)_minmax(7rem,12rem)] sm:items-center sm:gap-y-0 sm:px-4 sm:py-2"
                  style={{ borderLeftColor: color }}
                >
                  <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-span-1 sm:block">
                    <span className="tnum text-xs text-[var(--color-ink-soft)]">{s.startTime ? `${prettyTime(s.startTime)}${s.endTime ? `–${prettyTime(s.endTime)}` : ""}` : "—"}</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium sm:hidden" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                      {STATUS_LABEL[s.status] ?? s.status}
                    </span>
                  </span>
                  <span className="hidden items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium sm:inline-flex" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                    {STATUS_LABEL[s.status] ?? s.status}
                  </span>
                  <span className="col-span-2 min-w-0 sm:col-span-1">
                    <span className="block break-words text-sm font-medium sm:truncate">{s.programName}</span>
                    <span className="block break-words text-xs text-[var(--color-ink-soft)] sm:truncate">{s.individualNames.join(", ")}</span>
                  </span>
                  <span className="col-span-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs sm:col-span-1 sm:flex-col sm:items-end sm:justify-center sm:gap-0.5">
                    <span className="min-w-0 break-words text-[var(--color-ink-faint)] sm:max-w-full sm:truncate">{s.employeeName ?? "Unassigned"}</span>
                    {flagged ? (
                      <span className="shrink-0 font-semibold sm:max-w-full sm:truncate" style={{ color }} title={`${s.warningCount} warning(s)`}>
                        {tone === "over_risk" ? "Budget risk" : "Needs review"}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ===========================================================================
 * Utilization strip: at-a-glance budget headroom for the individual in focus,
 * so a planner sees whether the authorization will be used before it renews.
 * ========================================================================= */
function UtilizationStrip({ summary, loading }: { summary: ScheduleUtilizationSummary | null; loading: boolean }) {
  if (loading && !summary) {
    return (
      <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-ink-faint)]">
        Loading utilization…
      </div>
    );
  }
  if (!summary) return null;

  if (!summary.hasAuthorization) {
    return (
      <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 text-sm">
        <span className="font-medium">{summary.individualName}</span>{" "}
        <span className="text-[var(--color-ink-faint)]">has no active authorization, so utilization cannot be shown. Add a budget period and authorization to plan against a budget.</span>
      </div>
    );
  }

  const usagePctNum = dec(summary.usagePercent).times(100).toNumber();
  const committedPctNum = dec(summary.committedPercent).times(100).toNumber();
  const elapsedNum = dec(summary.timeElapsedPercent).times(100).toNumber();
  const remaining = dec(summary.remainingAfterHours);
  const overBudget = remaining.isNegative();
  const barTone: "good" | "warn" | "danger" = overBudget ? "danger" : usagePctNum >= 90 ? "warn" : "good";
  const bigTone: "good" | "warn" | "danger" = overBudget ? "danger" : committedPctNum >= 100 ? "warn" : "good";

  // Pace to fully utilize the remaining, unscheduled hours before the period ends.
  const days = summary.daysRemaining;
  const weeksLeft = days !== null && days > 0 ? days / 7 : null;
  const requiredWeekly = weeksLeft && remaining.gt(0) ? remaining.dividedBy(weeksLeft) : null;

  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow">Budget utilization</p>
          <p className="display text-sm font-medium">
            {summary.individualName}
            {summary.period ? <span className="ml-2 text-xs font-normal text-[var(--color-ink-faint)]">{summary.period.label} · {summary.period.startDate} → {summary.period.endDate}</span> : null}
          </p>
        </div>
        <UtilizationBadge status={summary.status} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BigStat label="Authorized" value={`${formatHours(summary.authorizedHours)} h`} hint="this budget period" />
        <BigStat label="Used" value={`${formatHours(summary.usedHours)} h`} tone={bigTone} hint={`${formatPercent(summary.usagePercent)} of authorized`} />
        <BigStat label="Scheduled" value={`${formatHours(summary.scheduledHours)} h`} tone={dec(summary.scheduledHours).isZero() ? "muted" : "info"} hint="future sessions" />
        <BigStat
          label="Unscheduled remaining"
          value={`${formatHours(summary.remainingAfterHours)} h`}
          tone={overBudget ? "danger" : "good"}
          hint={overBudget ? "over authorization" : "still available to plan"}
        />
      </div>

      <div className="mt-3">
        <ProgressBar percent={usagePctNum} tone={barTone} target={elapsedNum} label="Hours used vs. period elapsed" />
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
          The marker is how far the budget period has elapsed. {formatPercent(summary.committedPercent)} committed once scheduled work is counted.
          {overBudget
            ? ` Scheduling exceeds the authorization by ${formatHours(remaining.abs())} h — reduce or reallocate.`
            : requiredWeekly
              ? ` ${formatHours(summary.remainingAfterHours)} h remain unscheduled with ${days} day${days === 1 ? "" : "s"} left — about ${formatHours(requiredWeekly)} h/week to fully utilize.`
              : days !== null && days <= 0
                ? " The budget period has ended."
                : ` ${formatHours(summary.remainingAfterHours)} h remain unscheduled.`}
        </p>
      </div>

      {summary.programs.length > 1 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {summary.programs.map((p) => {
            const pOver = p.remainingAfterHours !== null && dec(p.remainingAfterHours).isNegative();
            const pColor = EVENT_TONE_COLOR[pOver ? "over_risk" : dec(p.usagePercent).gte("0.9") ? "flagged" : "on_track"];
            return (
              <div key={p.programId} className="rounded border border-[var(--color-rule)] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium">{p.programName}</span>
                  <span className="tnum text-xs" style={{ color: pColor }}>{p.remainingAfterHours === null ? "—" : `${formatHours(p.remainingAfterHours)} h left`}</span>
                </div>
                <div className="mt-1.5">
                  <PaceBar usagePercent={p.usagePercent} timeElapsedPercent={summary.timeElapsedPercent} color={pColor} />
                </div>
                <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
                  {formatHours(p.usedHours)} used · {formatHours(p.scheduledHours)} scheduled · {formatHours(p.authorizedHours ?? "0")} authorized
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* A compact key so the event colours are legible without hovering. */
function CalendarLegend() {
  const items: EventTone[] = ["on_track", "flagged", "over_risk", "cancelled"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-[var(--color-ink-soft)]">
      <span className="eyebrow">Legend</span>
      {items.map((t) => (
        <span key={t} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: EVENT_TONE_COLOR[t] }} />
          {EVENT_TONE_LABEL[t]}
        </span>
      ))}
      <span className="text-[var(--color-ink-faint)]">✓ completed</span>
    </div>
  );
}

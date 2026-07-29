"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarSession } from "@/lib/data/schedule-queries";
import {
  send, SessionChip, addDays, weekday, startOfWeek, startOfMonth, monthGridStart,
  monthLabel, humanDate, prettyTime, WEEKDAYS, STATUS_STYLE, STATUS_LABEL,
  type Picker, type ProgramPicker, type View,
} from "./shared";
import SessionDetail from "./session-detail";
import CreateSessionModal from "./create-session-modal";

export interface ScheduleCalendarProps {
  canManage: boolean;
  today: string; // YYYY-MM-DD, from the server, to avoid timezone drift
  employees: Picker[];
  individuals: Picker[];
  programs: ProgramPicker[];
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
  const { canManage, today, employees, individuals, programs, initialFilters } = props;

  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(today);
  const [filters, setFilters] = useState({
    employeeId: initialFilters?.employeeId ?? "",
    individualId: initialFilters?.individualId ?? "",
    programId: initialFilters?.programId ?? "",
    unassigned: initialFilters?.unassigned ?? false,
    status: initialFilters?.status ?? "",
  });
  const [sessions, setSessions] = useState<CalendarSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalendarSession | null>(null);
  const [creating, setCreating] = useState<null | { date: string }>(null);

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
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ from: range.from, to: range.to });
    if (filters.employeeId) qs.set("employeeId", filters.employeeId);
    if (filters.individualId) qs.set("individualId", filters.individualId);
    if (filters.programId) qs.set("programId", filters.programId);
    if (filters.unassigned) qs.set("unassigned", "true");
    if (filters.status) qs.set("status", filters.status);
    const res = await send("GET", `/api/schedule/sessions?${qs.toString()}`);
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? "Could not load the schedule.");
      setSessions([]);
      return;
    }
    const data = res.data as { sessions: CalendarSession[] };
    setSessions(data.sessions ?? []);
  }, [range, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarSession[]>();
    for (const s of sessions) {
      const arr = map.get(s.sessionDate) ?? [];
      arr.push(s);
      map.set(s.sessionDate, arr);
    }
    return map;
  }, [sessions]);

  function step(dir: number) {
    if (view === "day") setAnchor(addDays(anchor, dir));
    else if (view === "week") setAnchor(addDays(anchor, dir * 7));
    else setAnchor(addDays(startOfMonth(anchor), dir > 0 ? 32 : -1));
  }

  const label = view === "month" ? monthLabel(anchor) : view === "week" ? `Week of ${humanDate(startOfWeek(anchor))}` : humanDate(anchor);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded border border-[var(--color-rule-strong)]">
          {(["month", "week", "day"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm capitalize ${
                view === v ? "bg-[var(--color-primary)] text-white" : "bg-white text-[var(--color-ink)]"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={() => step(-1)} aria-label="Previous" className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5 text-sm">←</button>
          <button type="button" onClick={() => setAnchor(today)} className="rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm">Today</button>
          <button type="button" onClick={() => step(1)} aria-label="Next" className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5 text-sm">→</button>
        </div>
        <p className="display text-base font-medium">{label}</p>
        <div className="ml-auto flex items-center gap-2">
          {loading ? <span className="text-xs text-[var(--color-ink-faint)]">Loading…</span> : null}
          {canManage ? (
            <button type="button" onClick={() => setCreating({ date: view === "month" ? today : anchor })} className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white">
              New session
            </button>
          ) : null}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2 text-sm">
        <span className="eyebrow">View</span>
        <select value={filters.employeeId} onChange={(e) => setFilters((f) => ({ ...f, employeeId: e.target.value, unassigned: false }))} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm">
          <option value="">All employees</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
        <select value={filters.individualId} onChange={(e) => setFilters((f) => ({ ...f, individualId: e.target.value }))} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm">
          <option value="">All individuals</option>
          {individuals.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
        <select value={filters.programId} onChange={(e) => setFilters((f) => ({ ...f, programId: e.target.value }))} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm">
          <option value="">All programs</option>
          {programs.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm">
          <option value="">Any status</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="no_show">No-show</option>
        </select>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={filters.unassigned} onChange={(e) => setFilters((f) => ({ ...f, unassigned: e.target.checked, employeeId: e.target.checked ? "" : f.employeeId }))} />
          Unassigned only
        </label>
        {(filters.employeeId || filters.individualId || filters.programId || filters.status || filters.unassigned) ? (
          <button type="button" onClick={() => setFilters({ employeeId: "", individualId: "", programId: "", unassigned: false, status: "" })} className="text-xs text-[var(--color-primary)] underline">
            Clear
          </button>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-[var(--color-pace-over)] bg-[#fdf2f5] px-4 py-3 text-sm text-[var(--color-pace-over)]">{error}</div>
      ) : null}

      {view === "month" ? (
        <MonthGrid anchor={anchor} today={today} byDate={byDate} onSelect={setSelected} onAdd={canManage ? (d) => setCreating({ date: d }) : undefined} />
      ) : view === "week" ? (
        <WeekList anchor={anchor} today={today} byDate={byDate} onSelect={setSelected} onAdd={canManage ? (d) => setCreating({ date: d }) : undefined} />
      ) : (
        <DayList date={anchor} today={today} sessions={byDate.get(anchor) ?? []} onSelect={setSelected} onAdd={canManage ? (d) => setCreating({ date: d }) : undefined} />
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
          onClose={() => setCreating(null)}
          onCreated={() => { setCreating(null); void load(); }}
        />
      ) : null}
    </div>
  );
}

/* ===========================================================================
 * Month grid.
 * ========================================================================= */
function MonthGrid({
  anchor, today, byDate, onSelect, onAdd,
}: {
  anchor: string;
  today: string;
  byDate: Map<string, CalendarSession[]>;
  onSelect: (s: CalendarSession) => void;
  onAdd?: (date: string) => void;
}) {
  const gridStart = monthGridStart(anchor);
  const month = anchor.slice(0, 7);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]">
      <div className="grid grid-cols-7 border-b border-[var(--color-rule)] text-xs font-semibold text-[var(--color-ink-faint)]">
        {WEEKDAYS.map((w) => <div key={w} className="px-2 py-1.5 text-center uppercase">{w}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const isToday = d === today;
          const list = byDate.get(d) ?? [];
          return (
            <div key={d} className={`min-h-[92px] border-b border-r border-[var(--color-rule)] p-1 ${inMonth ? "" : "bg-[var(--color-paper)]"}`}>
              <div className="mb-1 flex items-center justify-between">
                <span className={`tnum text-xs ${isToday ? "rounded bg-[var(--color-primary)] px-1.5 py-0.5 font-semibold text-white" : inMonth ? "text-[var(--color-ink)]" : "text-[var(--color-ink-faint)]"}`}>
                  {Number(d.slice(8, 10))}
                </span>
                {onAdd ? <button type="button" onClick={() => onAdd(d)} aria-label={`Add session on ${d}`} className="text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-primary)]">+</button> : null}
              </div>
              <div className="space-y-0.5">
                {list.slice(0, 4).map((s) => <SessionChip key={s.id} s={s} onSelect={onSelect} />)}
                {list.length > 4 ? <span className="block px-1 text-[10px] text-[var(--color-ink-faint)]">+{list.length - 4} more</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ===========================================================================
 * Week + day lists.
 * ========================================================================= */
function WeekList({
  anchor, today, byDate, onSelect, onAdd,
}: {
  anchor: string;
  today: string;
  byDate: Map<string, CalendarSession[]>;
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
            {onAdd ? <button type="button" onClick={() => onAdd(d)} className="text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-primary)]">+</button> : null}
          </div>
          <div className="space-y-1">
            {(byDate.get(d) ?? []).map((s) => <SessionChip key={s.id} s={s} onSelect={onSelect} />)}
            {(byDate.get(d) ?? []).length === 0 ? <p className="text-[11px] text-[var(--color-ink-faint)]">—</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function DayList({
  date, today, sessions, onSelect, onAdd,
}: {
  date: string;
  today: string;
  sessions: CalendarSession[];
  onSelect: (s: CalendarSession) => void;
  onAdd?: (date: string) => void;
}) {
  const sorted = [...sessions].sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-4 py-2">
        <span className="text-sm font-medium">{humanDate(date)}{date === today ? " · today" : ""}</span>
        {onAdd ? <button type="button" onClick={() => onAdd(date)} className="rounded border border-[var(--color-rule-strong)] px-2 py-1 text-xs">Add session</button> : null}
      </div>
      {sorted.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">Nothing scheduled.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-rule)]">
          {sorted.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onSelect(s)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--color-paper)]">
                <span className="tnum w-24 text-xs text-[var(--color-ink-soft)]">{s.startTime ? `${prettyTime(s.startTime)}${s.endTime ? `–${prettyTime(s.endTime)}` : ""}` : "—"}</span>
                <span className={`rounded border-l-2 px-1.5 py-0.5 text-xs ${STATUS_STYLE[s.status]}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                <span className="text-sm">{s.programName}</span>
                <span className="text-xs text-[var(--color-ink-soft)]">{s.individualNames.join(", ")}</span>
                <span className="ml-auto text-xs text-[var(--color-ink-faint)]">{s.employeeName ?? "Unassigned"}</span>
                {s.warningCount > 0 ? <span className="text-[var(--color-pace-near)]" title={`${s.warningCount} warning(s)`}>⚠</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

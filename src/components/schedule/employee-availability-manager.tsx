"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Archive, CalendarOff, Clock3, Plus } from "lucide-react";
import { EmptyState, Table, Td, Th, Tr } from "@/components/ui";
import type {
  EmployeeAvailabilityRules,
  EmployeeUnavailabilityWindow,
  WeeklyAvailabilityWindow,
} from "@/lib/manage/employee-availability";
import { ModalShell, prettyTime, send, type Picker } from "./shared";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EMPTY_RULES: EmployeeAvailabilityRules = { weekly: [], unavailable: [], scheduleConflicts: [] };
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

type Editor = "weekly" | "unavailable" | null;
type ArchiveTarget = WeeklyAvailabilityWindow | EmployeeUnavailabilityWindow;

function dateLabel(value: string): string {
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`));
}

function rangeLabel(start: string, end: string | null): string {
  return end ? `${dateLabel(start)} to ${dateLabel(end)}` : `${dateLabel(start)} onward`;
}

function inputClass(): string {
  return "mt-1 h-10 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-soft)]";
}

export default function EmployeeAvailabilityManager({
  employees,
  initialEmployeeId,
  today,
  canManage,
}: {
  employees: Picker[];
  initialEmployeeId?: string;
  today: string;
  canManage: boolean;
}) {
  const firstEmployeeId = initialEmployeeId && employees.some((employee) => employee.id === initialEmployeeId)
    ? initialEmployeeId
    : employees[0]?.id ?? "";
  const [employeeId, setEmployeeId] = useState(firstEmployeeId);
  const [rules, setRules] = useState<EmployeeAvailabilityRules>(EMPTY_RULES);
  const [loading, setLoading] = useState(Boolean(firstEmployeeId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [effectiveTo, setEffectiveTo] = useState("");
  const [notes, setNotes] = useState("");
  const [timeOffStart, setTimeOffStart] = useState(today);
  const [timeOffEnd, setTimeOffEnd] = useState(today);
  const [fullDay, setFullDay] = useState(true);
  const [timeOffStartTime, setTimeOffStartTime] = useState("09:00");
  const [timeOffEndTime, setTimeOffEndTime] = useState("17:00");
  const [timeOffLabel, setTimeOffLabel] = useState("");
  const loadRequestId = useRef(0);

  const selectedName = employees.find((employee) => employee.id === employeeId)?.label ?? "employee";
  const sortedWeekly = useMemo(() => [...rules.weekly].sort((a, b) =>
    a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)), [rules.weekly]);
  const sortedUnavailable = useMemo(() => [...rules.unavailable].sort((a, b) =>
    a.startDate.localeCompare(b.startDate) || (a.startTime ?? "").localeCompare(b.startTime ?? "")), [rules.unavailable]);

  const load = useCallback(async (id: string) => {
    const requestId = ++loadRequestId.current;
    if (!id) {
      setRules(EMPTY_RULES);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setLoadError(null);
    const result = await send("GET", `/api/employee-availability?employeeId=${encodeURIComponent(id)}`);
    if (requestId !== loadRequestId.current) return;
    setLoading(false);
    if (!result.ok) {
      setRules(EMPTY_RULES);
      setLoadError(result.error ?? "Could not load employee hours.");
      return;
    }
    setRules(result.data as EmployeeAvailabilityRules);
  }, []);

  useEffect(() => {
    void load(employeeId);
    return () => {
      loadRequestId.current += 1;
    };
  }, [employeeId, load]);

  const changeEmployee = (id: string) => {
    setEmployeeId(id);
    setNotice(null);
    setLoadError(null);
    setEditor(null);
    setArchiveTarget(null);
  };

  const openWeekly = () => {
    setWeekday(1);
    setStartTime("09:00");
    setEndTime("17:00");
    setEffectiveFrom(today);
    setEffectiveTo("");
    setNotes("");
    setError(null);
    setEditor("weekly");
  };

  const openUnavailable = () => {
    setTimeOffStart(today);
    setTimeOffEnd(today);
    setFullDay(true);
    setTimeOffStartTime("09:00");
    setTimeOffEndTime("17:00");
    setTimeOffLabel("");
    setError(null);
    setEditor("unavailable");
  };

  const saveWeekly = async () => {
    if (!employeeId) return;
    if (!effectiveFrom || !startTime || !endTime || endTime <= startTime) {
      setError("Choose valid dates and working hours.");
      return;
    }
    if (effectiveTo && effectiveTo < effectiveFrom) {
      setError("The end date must be on or after the start date.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await send("POST", "/api/employee-availability", {
      kind: "weekly",
      employeeId,
      weekday,
      startTime,
      endTime,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
      notes: notes || null,
      reason: `Weekly hours entered for ${selectedName}`,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not save weekly hours.");
      return;
    }
    setEditor(null);
    setNotice(`${WEEKDAYS[weekday]} hours saved.`);
    await load(employeeId);
  };

  const saveUnavailable = async () => {
    if (!employeeId) return;
    if (!timeOffStart || !timeOffEnd || timeOffEnd < timeOffStart) {
      setError("Choose a valid date range.");
      return;
    }
    if (!fullDay && timeOffStart !== timeOffEnd) {
      setError("Timed entries are for one day. Choose Full day for a date range.");
      return;
    }
    if (!fullDay && (!timeOffStartTime || !timeOffEndTime || timeOffEndTime <= timeOffStartTime)) {
      setError("Choose valid unavailable hours.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await send("POST", "/api/employee-availability", {
      kind: "unavailable",
      employeeId,
      startDate: timeOffStart,
      endDate: timeOffEnd,
      startTime: fullDay ? null : timeOffStartTime,
      endTime: fullDay ? null : timeOffEndTime,
      label: timeOffLabel || null,
      reason: `Unavailable time entered for ${selectedName}`,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not save unavailable time.");
      return;
    }
    setEditor(null);
    setNotice("Unavailable time saved.");
    await load(employeeId);
  };

  const archive = async () => {
    if (!archiveTarget || !archiveReason.trim()) {
      setError("Enter a reason before removing this entry.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await send("PATCH", `/api/employee-availability/${archiveTarget.id}`, {
      action: "archive",
      kind: archiveTarget.kind,
      reason: archiveReason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not remove this entry.");
      return;
    }
    setArchiveTarget(null);
    setArchiveReason("");
    setNotice("Entry removed from the active schedule.");
    await load(employeeId);
  };

  if (employees.length === 0) {
    return (
      <EmptyState compact title="No employees available" icon={<Clock3 aria-hidden className="h-5 w-5" />}>
        Add employees to the planning roster first.
      </EmptyState>
    );
  }

  return (
    <div>
      <div className="mb-5 max-w-md">
        <label className="text-sm font-medium">
          Employee
          <select value={employeeId} onChange={(event) => changeEmployee(event.target.value)} className={inputClass()}>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}</option>)}
          </select>
        </label>
      </div>

      {loadError ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">
          <span>{loadError}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void load(employeeId)}>Try again</button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mb-4 border-l-2 border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">{error}</p> : null}
      {notice ? <p role="status" className="mb-4 border-l-2 border-[var(--color-pace-on)] bg-[#f0f8f5] px-3 py-2 text-sm text-[var(--color-pace-on)]">{notice}</p> : null}
      {loading ? <p role="status" className="py-8 text-sm text-[var(--color-ink-soft)]">Loading employee hours...</p> : (
        loadError ? null :
        <div className="space-y-8">
          {rules.scheduleConflicts.length > 0 ? (
            <section aria-labelledby="availability-review-heading" className="border-l-2 border-[var(--color-pace-near)] bg-[var(--color-warn-soft)] px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-pace-near)]" />
                <div className="min-w-0 flex-1">
                  <h3 id="availability-review-heading" className="text-sm font-semibold">Schedule review needed</h3>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
                    {rules.scheduleConflicts.length} future {rules.scheduleConflicts.length === 1 ? "session overlaps" : "sessions overlap"} this employee&apos;s time off. Open a session to reschedule or cancel it.
                  </p>
                  <ul className="mt-3 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                    {rules.scheduleConflicts.map((conflict) => (
                      <li key={conflict.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="font-semibold">{dateLabel(conflict.sessionDate)} · {conflict.startTime ? `${prettyTime(conflict.startTime)}${conflict.endTime ? ` to ${prettyTime(conflict.endTime)}` : ""}` : `${conflict.durationHours} hours`}</p>
                          <p className="truncate text-xs text-[var(--color-ink-soft)]">{conflict.programName} · {conflict.individualNames.join(", ") || "Individual not assigned"}</p>
                        </div>
                        <Link
                          className="btn btn-sm btn-secondary shrink-0"
                          href={`/schedule?view=calendar&calendarView=day&date=${encodeURIComponent(conflict.sessionDate)}&employeeId=${encodeURIComponent(employeeId)}&sessionId=${encodeURIComponent(conflict.id)}`}
                        >
                          Review session
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ) : null}

          <section aria-labelledby="weekly-hours-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule)] pb-2">
              <div>
                <h3 id="weekly-hours-heading" className="text-sm font-semibold">Weekly hours</h3>
                <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Normal working times used by the calendar.</p>
              </div>
              {canManage ? <button type="button" onClick={openWeekly} className="btn btn-sm btn-primary"><Plus aria-hidden className="h-4 w-4" />Add hours</button> : null}
            </div>
            {sortedWeekly.length === 0 ? (
              <EmptyState compact title="Hours not entered" icon={<Clock3 aria-hidden className="h-5 w-5" />}>
                The calendar will still check assignments and schedule conflicts.
              </EmptyState>
            ) : (
              <div className="border-y border-[var(--color-rule)]">
                <Table caption={`Weekly working hours for ${selectedName}`} head={<><Th>Day</Th><Th>Hours</Th><Th>Effective dates</Th><Th>Note</Th><Th><span className="sr-only">Actions</span></Th></>}>
                  {sortedWeekly.map((window) => (
                    <Tr key={window.id}>
                      <Td><span className="font-semibold">{WEEKDAYS[window.weekday]}</span></Td>
                      <Td><span className="tnum whitespace-nowrap">{prettyTime(window.startTime)} to {prettyTime(window.endTime)}</span></Td>
                      <Td><span className="whitespace-nowrap">{rangeLabel(window.effectiveFrom, window.effectiveTo)}</span></Td>
                      <Td>{window.notes ?? <span className="text-[var(--color-ink-faint)]">-</span>}</Td>
                      <Td>{canManage ? <button type="button" onClick={() => { setArchiveTarget(window); setArchiveReason(""); setError(null); }} className="btn btn-icon btn-sm" aria-label={`Remove ${WEEKDAYS[window.weekday]} hours`} title="Remove hours"><Archive aria-hidden className="h-4 w-4" /></button> : null}</Td>
                    </Tr>
                  ))}
                </Table>
              </div>
            )}
          </section>

          <section aria-labelledby="time-off-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule)] pb-2">
              <div>
                <h3 id="time-off-heading" className="text-sm font-semibold">Time off</h3>
                <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Full days or specific times when this employee is unavailable.</p>
              </div>
              {canManage ? <button type="button" onClick={openUnavailable} className="btn btn-sm btn-primary"><Plus aria-hidden className="h-4 w-4" />Add time off</button> : null}
            </div>
            {sortedUnavailable.length === 0 ? (
              <EmptyState compact title="No time off entered" icon={<CalendarOff aria-hidden className="h-5 w-5" />} />
            ) : (
              <div className="border-y border-[var(--color-rule)]">
                <Table caption={`Unavailable dates for ${selectedName}`} head={<><Th>Date</Th><Th>Time</Th><Th>Note</Th><Th><span className="sr-only">Actions</span></Th></>}>
                  {sortedUnavailable.map((window) => (
                    <Tr key={window.id}>
                      <Td><span className="whitespace-nowrap">{window.startDate === window.endDate ? dateLabel(window.startDate) : `${dateLabel(window.startDate)} to ${dateLabel(window.endDate)}`}</span></Td>
                      <Td>{window.startTime ? <span className="tnum whitespace-nowrap">{prettyTime(window.startTime)} to {prettyTime(window.endTime)}</span> : "Full day"}</Td>
                      <Td>{window.label ?? <span className="text-[var(--color-ink-faint)]">-</span>}</Td>
                      <Td>{canManage ? <button type="button" onClick={() => { setArchiveTarget(window); setArchiveReason(""); setError(null); }} className="btn btn-icon btn-sm" aria-label={`Remove time off starting ${dateLabel(window.startDate)}`} title="Remove time off"><Archive aria-hidden className="h-4 w-4" /></button> : null}</Td>
                    </Tr>
                  ))}
                </Table>
              </div>
            )}
          </section>
          {!canManage ? <p className="text-xs text-[var(--color-ink-faint)]">You have read-only access to employee hours.</p> : null}
        </div>
      )}

      {editor === "weekly" ? (
        <ModalShell title={`Add weekly hours for ${selectedName}`} onClose={() => !busy && setEditor(null)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium sm:col-span-2">Day<select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} className={inputClass()}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
            <label className="text-sm font-medium">Start<input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} className={inputClass()} /></label>
            <label className="text-sm font-medium">End<input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} className={inputClass()} /></label>
            <label className="text-sm font-medium">Starts<input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} className={inputClass()} /></label>
            <label className="text-sm font-medium">Ends <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span><input type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} className={inputClass()} /></label>
            <label className="text-sm font-medium sm:col-span-2">Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span><input value={notes} onChange={(event) => setNotes(event.target.value)} className={inputClass()} maxLength={500} /></label>
          </div>
          {error ? <p role="alert" className="mt-4 text-sm text-[var(--color-pace-over)]">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setEditor(null)} disabled={busy} className="btn btn-sm">Cancel</button><button type="button" onClick={saveWeekly} disabled={busy} className="btn btn-sm btn-primary">{busy ? "Saving..." : "Save hours"}</button></div>
        </ModalShell>
      ) : null}

      {editor === "unavailable" ? (
        <ModalShell title={`Add time off for ${selectedName}`} onClose={() => !busy && setEditor(null)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Starts<input type="date" value={timeOffStart} onChange={(event) => { setTimeOffStart(event.target.value); if (fullDay) setTimeOffEnd(event.target.value); }} className={inputClass()} /></label>
            <label className="text-sm font-medium">Ends<input type="date" value={timeOffEnd} onChange={(event) => setTimeOffEnd(event.target.value)} className={inputClass()} /></label>
            <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2"><input type="checkbox" checked={fullDay} onChange={(event) => { setFullDay(event.target.checked); if (!event.target.checked) setTimeOffEnd(timeOffStart); }} className="h-4 w-4 accent-[var(--color-primary)]" />Full day</label>
            {!fullDay ? <><label className="text-sm font-medium">Start<input type="time" value={timeOffStartTime} onChange={(event) => setTimeOffStartTime(event.target.value)} className={inputClass()} /></label><label className="text-sm font-medium">End<input type="time" value={timeOffEndTime} onChange={(event) => setTimeOffEndTime(event.target.value)} className={inputClass()} /></label></> : null}
            <label className="text-sm font-medium sm:col-span-2">Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span><input value={timeOffLabel} onChange={(event) => setTimeOffLabel(event.target.value)} className={inputClass()} maxLength={200} /></label>
          </div>
          {error ? <p role="alert" className="mt-4 text-sm text-[var(--color-pace-over)]">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setEditor(null)} disabled={busy} className="btn btn-sm">Cancel</button><button type="button" onClick={saveUnavailable} disabled={busy} className="btn btn-sm btn-primary">{busy ? "Saving..." : "Save time off"}</button></div>
        </ModalShell>
      ) : null}

      {archiveTarget ? (
        <ModalShell title={archiveTarget.kind === "weekly" ? "Remove weekly hours" : "Remove time off"} onClose={() => !busy && setArchiveTarget(null)}>
          <p className="text-sm text-[var(--color-ink-soft)]">This removes the entry from future calendar checks and keeps its history.</p>
          <label className="mt-4 block text-sm font-medium">Reason<input value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} className={inputClass()} placeholder="Why is this changing?" /></label>
          {error ? <p role="alert" className="mt-4 text-sm text-[var(--color-pace-over)]">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setArchiveTarget(null)} disabled={busy} className="btn btn-sm">Cancel</button><button type="button" onClick={archive} disabled={busy} className="btn btn-sm btn-primary">{busy ? "Removing..." : "Remove"}</button></div>
        </ModalShell>
      ) : null}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { CalendarSession } from "@/lib/data/schedule-queries";
import type { EmployeeAvailabilityResult } from "@/lib/data/employee-availability";
import { employeeAvailabilityLabel } from "@/lib/business/employee-availability-label";
import {
  send,
  ModalShell,
  humanDate,
  prettyTime,
  STATUS_STYLE,
  STATUS_LABEL,
  type Picker,
  type SessionFlags,
} from "./shared";

export type SessionRepairMode = "reschedule" | "duplicate" | "staffing";

/** Detail panel for one planned session, with the manager actions. */
export default function SessionDetail({
  session, flags, employees, canManage, initialMode = null, onClose, onChanged,
}: {
  session: CalendarSession;
  flags?: SessionFlags;
  employees: Picker[];
  canManage: boolean;
  initialMode?: SessionRepairMode | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<SessionRepairMode | null>(initialMode);
  const [reDate, setReDate] = useState(session.sessionDate);
  const [reStart, setReStart] = useState(session.startTime ?? "");
  const [reEnd, setReEnd] = useState(session.endTime ?? "");
  const [dupDate, setDupDate] = useState(session.sessionDate);
  const [employeeId, setEmployeeId] = useState(session.employeeId ?? "");
  const [availability, setAvailability] = useState<EmployeeAvailabilityResult | null>(null);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "staffing") return;
    let cancelled = false;
    setAvailabilityBusy(true);
    setAvailabilityError(null);
    void send("POST", "/api/schedule/preview", {
      employeeId: employeeId || null,
      programId: session.programId,
      individualIds: session.individualIds,
      sessionDate: session.sessionDate,
      startTime: session.startTime,
      endTime: session.endTime,
      durationHours: session.durationHours,
      excludeSessionId: session.id,
    }).then((result) => {
      if (cancelled) return;
      setAvailabilityBusy(false);
      if (!result.ok) {
        setAvailability(null);
        setAvailabilityError(result.error ?? "Could not check employee availability.");
        return;
      }
      const data = result.data as { employeeAvailability?: EmployeeAvailabilityResult };
      setAvailability(data.employeeAvailability ?? null);
      setAvailabilityError(null);
    });
    return () => { cancelled = true; };
  }, [employeeId, mode, session]);

  const employeeOptions = useMemo(() => {
    const byId = new Map(employees.map((employee) => [employee.id, employee]));
    if (!availability) return employees.map((employee) => ({ employee, signal: null }));
    return availability.employees.map((signal) => ({
      employee: byId.get(signal.employeeId) ?? { id: signal.employeeId, label: signal.employeeName },
      signal,
    }));
  }, [availability, employees]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await send("PATCH", `/api/schedule/sessions/${session.id}`, { ...body, reason: reason.trim() || undefined });
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "Action failed."); return; }
    onChanged();
  }

  return (
    <ModalShell title="Session" onClose={onClose}>
      <div className="space-y-3 text-sm">
        {error ? <p role="alert" className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-[var(--color-pace-over)]">{error}</p> : null}

        <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5">
          <dt className="text-[var(--color-ink-faint)]">Date</dt><dd className="col-span-2">{humanDate(session.sessionDate)}</dd>
          <dt className="text-[var(--color-ink-faint)]">Time</dt><dd className="col-span-2 tnum">{session.startTime ? `${prettyTime(session.startTime)}${session.endTime ? `–${prettyTime(session.endTime)}` : ""}` : "—"} · {session.durationHours} h</dd>
          <dt className="text-[var(--color-ink-faint)]">Program</dt><dd className="col-span-2">{session.programName}</dd>
          <dt className="text-[var(--color-ink-faint)]">Employee</dt><dd className="col-span-2">{session.employeeId && session.employeeName ? <Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/employees/${session.employeeId}`}>{session.employeeName}</Link> : <span className="text-[var(--color-pace-near)]">Unassigned</span>}</dd>
          <dt className="text-[var(--color-ink-faint)]">{session.isGroup ? `Individuals (group of ${session.groupSize})` : "Individual"}</dt><dd className="col-span-2 flex flex-wrap gap-x-1">{session.individualIds.map((id, index) => <span key={id}><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/individuals/${id}`}>{session.individualNames[index] ?? "Individual"}</Link>{index < session.individualIds.length - 1 ? "," : ""}</span>)}</dd>
          <dt className="text-[var(--color-ink-faint)]">Status</dt><dd className="col-span-2"><span className={`rounded border-l-2 px-1.5 py-0.5 text-xs ${STATUS_STYLE[session.status]}`}>{STATUS_LABEL[session.status] ?? session.status}</span></dd>
          {session.warningCount > 0 ? (
            <>
              <dt className="text-[var(--color-pace-near)]">Warnings</dt>
              <dd className="col-span-2 text-[var(--color-pace-near)]">{session.warningCount} current planning {session.warningCount === 1 ? "warning" : "warnings"}.</dd>
            </>
          ) : null}
        </dl>

        {flags && session.warningCount > 0 ? (
          <div className="rounded border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-xs text-[var(--color-warn)]">
            <p className="font-semibold">Why this visit needs review</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {flags.hasAvailabilityConflict ? <li>The employee is unavailable or outside their entered working hours.</li> : null}
              {flags.hasScheduleConflict ? <li>The employee or individual has an overlapping visit.</li> : null}
              {flags.hasAssignmentGap ? <li>The employee does not have an effective assignment for this work.</li> : null}
              {flags.hasBudgetRisk ? <li>Authorization coverage or planned hours need review.</li> : null}
              {flags.hasOtherWarning ? <li>A program or participant setting needs review.</li> : null}
            </ul>
          </div>
        ) : null}

        {canManage ? (
          <>
            <label className="block">
              <span className="text-xs text-[var(--color-ink-faint)]">Reason (required when the calendar finds a warning)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Add a reason for an exception" className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
            </label>

            {mode === null ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {session.status !== "completed" ? <button type="button" disabled={busy} onClick={() => act({ action: "status", status: "completed" })} className="rounded bg-[var(--color-pace-on)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">Mark completed</button> : null}
                {session.canChangeSchedule && session.status !== "no_show" ? <button type="button" disabled={busy} onClick={() => act({ action: "status", status: "no_show" })} className="rounded border border-[var(--color-pace-over)] px-3 py-1.5 text-xs font-medium text-[var(--color-pace-over)] disabled:opacity-60">No-show</button> : null}
                {session.status !== "pending" ? <button type="button" disabled={busy} onClick={() => act({ action: "status", status: "pending" })} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs disabled:opacity-60">Reopen</button> : null}
                {session.canChangeSchedule && session.status !== "cancelled" ? <button type="button" disabled={busy} onClick={() => act({ action: "cancel" })} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs disabled:opacity-60">Cancel</button> : null}
                {session.canChangeSchedule ? <button type="button" onClick={() => setMode("reschedule")} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs">Reschedule</button> : null}
                {session.canChangeSchedule ? <button type="button" onClick={() => setMode("staffing")} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs">Change employee</button> : null}
                <button type="button" onClick={() => setMode("duplicate")} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs">Duplicate</button>
              </div>
            ) : mode === "reschedule" ? (
              <div className="space-y-2 rounded border border-[var(--color-rule)] p-3">
                <p className="text-xs font-medium">Move this occurrence</p>
                <div className="flex flex-wrap gap-2">
                  <label className="text-xs">Date<input type="date" value={reDate} onChange={(e) => setReDate(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
                  <label className="text-xs">Start<input type="time" value={reStart} onChange={(e) => setReStart(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
                  <label className="text-xs">End<input type="time" value={reEnd} onChange={(e) => setReEnd(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => act({ action: "reschedule", sessionDate: reDate, startTime: reStart || null, endTime: reEnd || null })} className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">Save</button>
                  <button type="button" onClick={() => setMode(null)} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs">Back</button>
                </div>
              </div>
            ) : mode === "staffing" ? (
              <div className="space-y-3 rounded border border-[var(--color-rule)] p-3">
                <div>
                  <p className="text-xs font-medium">Choose an employee for this visit</p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Availability, schedule conflicts, and assignments are checked for this exact date and time.</p>
                </div>
                <label className="block text-xs">
                  Employee
                  <select data-modal-initial-focus value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="mt-1 min-h-10 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5 text-sm">
                    <option value="">Leave unassigned</option>
                    {employeeOptions.map(({ employee, signal }) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.label}{signal && availability ? ` — ${employeeAvailabilityLabel(signal, availability.timeRangeKnown, availability.occurrenceCount)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {availabilityBusy ? <p role="status" className="text-xs text-[var(--color-ink-faint)]">Checking availability…</p> : null}
                {availabilityError ? <p role="alert" className="text-xs text-[var(--color-danger)]">{availabilityError}</p> : null}
                {availability && availability.timeRangeKnown ? (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Available employees">
                    {availability.employees.filter((employee) => employee.available).slice(0, 6).map((employee) => (
                      <button
                        key={employee.employeeId}
                        type="button"
                        aria-pressed={employeeId === employee.employeeId}
                        onClick={() => setEmployeeId(employee.employeeId)}
                        className={`min-h-10 rounded border px-2 py-1 text-xs ${employeeId === employee.employeeId ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white" : "border-[var(--color-rule-strong)] bg-white"}`}
                      >
                        {employee.employeeName} · available
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <button type="button" disabled={busy || availabilityBusy || employeeId === (session.employeeId ?? "")} onClick={() => act({ action: "reassign", employeeId: employeeId || null })} className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">Save employee</button>
                  <button type="button" onClick={() => setMode(null)} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs">Back</button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 rounded border border-[var(--color-rule)] p-3">
                <p className="text-xs font-medium">Copy to another date</p>
                <label className="text-xs">Date<input type="date" value={dupDate} onChange={(e) => setDupDate(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => act({ action: "duplicate", toDate: dupDate })} className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">Duplicate</button>
                  <button type="button" onClick={() => setMode(null)} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-xs">Back</button>
                </div>
              </div>
            )}
            {!session.canChangeSchedule ? (
              <p className="text-xs text-[var(--color-ink-faint)]">Date, time, cancellation, and no-show are locked to preserve recorded service history.</p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-[var(--color-ink-faint)]">You have read-only access. Managers can change sessions.</p>
        )}
      </div>
    </ModalShell>
  );
}

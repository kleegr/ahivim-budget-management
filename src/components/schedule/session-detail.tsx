"use client";

import Link from "next/link";
import { useState } from "react";
import type { CalendarSession } from "@/lib/data/schedule-queries";
import { send, ModalShell, humanDate, prettyTime, STATUS_STYLE, STATUS_LABEL } from "./shared";

/** Detail panel for one planned session, with the manager actions. */
export default function SessionDetail({
  session, canManage, onClose, onChanged,
}: {
  session: CalendarSession;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<null | "reschedule" | "duplicate">(null);
  const [reDate, setReDate] = useState(session.sessionDate);
  const [reStart, setReStart] = useState(session.startTime ?? "");
  const [reEnd, setReEnd] = useState(session.endTime ?? "");
  const [dupDate, setDupDate] = useState(session.sessionDate);

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

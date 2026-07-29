"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionPreview } from "@/lib/manage/schedule";
import {
  send, ModalShell, addDays, weekday, durationFromTimes, WEEKDAYS,
  type Picker, type ProgramPicker,
} from "./shared";

/** Create a one-time or recurring session, with a live forecast + warnings. */
export default function CreateSessionModal({
  defaultDate, employees, individuals, programs, onClose, onCreated,
}: {
  defaultDate: string;
  employees: Picker[];
  individuals: Picker[];
  programs: ProgramPicker[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [recurring, setRecurring] = useState(false);
  const [programId, setProgramId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [indSearch, setIndSearch] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [duration, setDuration] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [notes, setNotes] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  // recurring
  const [frequency, setFrequency] = useState<"weekly" | "daily">("weekly");
  const [interval, setInterval] = useState("1");
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([weekday(defaultDate)]));
  const [endDate, setEndDate] = useState(addDays(defaultDate, 28));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const individualIds = useMemo(() => [...picked], [picked]);
  const effectiveDuration = duration.trim() || durationFromTimes(startTime || null, endTime || null);

  // Live preview (debounced).
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!programId || individualIds.length === 0 || !date || !effectiveDuration) {
      setPreview(null);
      return;
    }
    previewTimer.current = setTimeout(async () => {
      const res = await send("POST", "/api/schedule/preview", {
        employeeId: employeeId || null,
        programId,
        individualIds,
        sessionDate: date,
        startTime: startTime || null,
        endTime: endTime || null,
        durationHours: effectiveDuration,
      });
      if (res.ok) setPreview(res.data as SessionPreview);
    }, 350);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [programId, employeeId, individualIds, date, startTime, endTime, effectiveDuration]);

  const filteredIndividuals = useMemo(() => {
    const q = indSearch.trim().toLowerCase();
    return q ? individuals.filter((i) => i.label.toLowerCase().includes(q)) : individuals;
  }, [individuals, indSearch]);

  const warnings = preview?.warnings ?? [];
  const hasWarnings = warnings.length > 0;

  function toggleInd(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleWeekday(n: number) {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });
  }

  async function submit() {
    setError(null);
    if (!programId) { setError("Choose a program."); return; }
    if (individualIds.length === 0) { setError("Choose at least one individual."); return; }
    if (!effectiveDuration) { setError("Enter a duration, or a start and end time."); return; }
    setBusy(true);
    const common = {
      employeeId: employeeId || null,
      programId,
      individualIds,
      startTime: startTime || null,
      endTime: endTime || null,
      durationHours: effectiveDuration,
      serviceType: serviceType || null,
      notes: notes || null,
      overrideReason: overrideReason || null,
      reason: overrideReason || null,
    };
    let res;
    if (recurring) {
      res = await send("POST", "/api/schedule/series", {
        ...common,
        frequency,
        interval: Number(interval) || 1,
        weekdays: [...weekdays],
        startDate: date,
        endDate,
      });
    } else {
      res = await send("POST", "/api/schedule/sessions", { ...common, sessionDate: date });
    }
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "Could not save."); return; }
    onCreated();
  }

  const selectedProgram = programs.find((p) => p.id === programId);
  const isGroup = individualIds.length > 1;

  return (
    <ModalShell title={recurring ? "New recurring schedule" : "New session"} onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Left: form */}
        <div className="space-y-3">
          {error ? <p role="alert" className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">{error}</p> : null}

          <div className="inline-flex overflow-hidden rounded border border-[var(--color-rule-strong)] text-sm">
            <button type="button" onClick={() => setRecurring(false)} className={`px-3 py-1 ${!recurring ? "bg-[var(--color-primary)] text-white" : "bg-white"}`}>One-time</button>
            <button type="button" onClick={() => setRecurring(true)} className={`px-3 py-1 ${recurring ? "bg-[var(--color-primary)] text-white" : "bg-white"}`}>Recurring</button>
          </div>

          <label className="block text-sm">
            <span className="font-medium">Program</span>
            <select value={programId} onChange={(e) => setProgramId(e.target.value)} className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm">
              <option value="">Choose…</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}{p.isGroupCapable ? " (group)" : ""}</option>)}
            </select>
          </label>

          <label className="block text-sm">
            <span className="font-medium">Employee <span className="text-[var(--color-ink-faint)]">(optional — leave blank to leave unassigned)</span></span>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm">
              <option value="">Unassigned</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </label>

          <div className="text-sm">
            <span className="font-medium">Individuals</span>
            {isGroup && selectedProgram && !selectedProgram.isGroupCapable ? (
              <span className="ml-2 text-xs text-[var(--color-pace-near)]">group of {individualIds.length} — program not marked group-capable</span>
            ) : isGroup ? <span className="ml-2 text-xs text-[var(--color-ink-faint)]">group of {individualIds.length}</span> : null}
            <input value={indSearch} onChange={(e) => setIndSearch(e.target.value)} placeholder="Search…" className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1 text-sm" />
            <div className="mt-1 max-h-40 overflow-y-auto rounded border border-[var(--color-rule)] p-1">
              {filteredIndividuals.length === 0 ? <p className="px-1 py-2 text-xs text-[var(--color-ink-faint)]">No matches.</p> : null}
              {filteredIndividuals.map((i) => (
                <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-[var(--color-paper)]">
                  <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggleInd(i.id)} />
                  {i.label}
                </label>
              ))}
            </div>
          </div>

          {!recurring ? (
            <label className="block text-sm">
              <span className="font-medium">Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
            </label>
          ) : (
            <div className="space-y-2 rounded border border-[var(--color-rule)] p-2">
              <div className="flex flex-wrap gap-2 text-sm">
                <label>Frequency
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value as "weekly" | "daily")} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm">
                    <option value="weekly">Weekly</option>
                    <option value="daily">Daily</option>
                  </select>
                </label>
                <label>Every
                  <input type="number" min={1} value={interval} onChange={(e) => setInterval(e.target.value)} className="mt-0.5 block w-16 rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" />
                </label>
                <span className="self-end pb-1 text-xs text-[var(--color-ink-faint)]">{frequency === "weekly" ? "week(s)" : "day(s)"}</span>
              </div>
              {frequency === "weekly" ? (
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((w, n) => (
                    <button key={w} type="button" onClick={() => toggleWeekday(n)} className={`rounded px-2 py-1 text-xs ${weekdays.has(n) ? "bg-[var(--color-primary)] text-white" : "border border-[var(--color-rule-strong)] bg-white"}`}>{w}</button>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 text-sm">
                <label>Start<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
                <label>End<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 text-sm">
            <label>Start<input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
            <label>End<input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
            <label>Duration (h)<input type="number" step="any" min={0} value={duration} onChange={(e) => setDuration(e.target.value)} placeholder={durationFromTimes(startTime || null, endTime || null) || "e.g. 2"} className="mt-0.5 block w-24 rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
          </div>

          <label className="block text-sm">
            <span className="font-medium">Service type <span className="text-[var(--color-ink-faint)]">(optional)</span></span>
            <input value={serviceType} onChange={(e) => setServiceType(e.target.value)} placeholder="e.g. respite, community habilitation" className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
          </label>

          <label className="block text-sm">
            <span className="font-medium">Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
          </label>

          {hasWarnings ? (
            <label className="block text-sm">
              <span className="font-medium text-[var(--color-pace-near)]">Override reason (warnings present)</span>
              <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why schedule despite the warnings" className="mt-1 w-full rounded border border-[var(--color-pace-near)] bg-white px-3 py-1.5 text-sm" />
            </label>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-sm">Cancel</button>
            <button type="button" disabled={busy} onClick={submit} className="rounded bg-[var(--color-primary)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60">
              {busy ? "Saving…" : recurring ? "Create series" : "Schedule"}
            </button>
          </div>
        </div>

        {/* Right: live forecast + warnings */}
        <div className="space-y-3">
          <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-paper)] p-3">
            <p className="eyebrow">Expected billing</p>
            {preview?.billing ? (
              <dl className="mt-1 grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-[var(--color-ink-faint)]">Rate</dt><dd className="tnum text-right">${preview.billing.expectedRate}</dd>
                <dt className="text-[var(--color-ink-faint)]">Internal</dt><dd className="tnum text-right">${preview.billing.internalAmount}</dd>
                <dt className="text-[var(--color-ink-faint)]">Agency gross</dt><dd className="tnum text-right">${preview.billing.agencyGross}</dd>
                {isGroup ? <><dt className="text-[var(--color-ink-faint)]">Per individual</dt><dd className="tnum text-right">{preview.billing.perIndividual.hours} h · ${preview.billing.perIndividual.amount}</dd></> : null}
              </dl>
            ) : <p className="mt-1 text-sm text-[var(--color-ink-faint)]">Pick a program, at least one individual, a date and a duration.</p>}
          </div>

          {warnings.length > 0 ? (
            <div className="rounded-lg border border-[var(--color-pace-near)] bg-[#fff8f2] p-3">
              <p className="eyebrow text-[var(--color-pace-near)]">Warnings — you can still save with a reason</p>
              <ul className="mt-1 space-y-1 text-xs text-[var(--color-ink-soft)]">
                {warnings.map((w, idx) => <li key={idx}>• {w.message}</li>)}
              </ul>
            </div>
          ) : preview ? (
            <div className="rounded-lg border border-[var(--color-pace-on)] bg-[#f0f9f3] p-3 text-xs text-[var(--color-pace-on)]">No conflicts detected.</div>
          ) : null}

          {preview && preview.forecast.length > 0 ? (
            <div className="rounded-lg border border-[var(--color-rule)] p-3">
              <p className="eyebrow">Forecast against authorisation</p>
              <div className="mt-2 space-y-2">
                {preview.forecast.map((f) => (
                  <div key={f.individualId} className="text-xs">
                    <p className="font-medium">{f.individualName}</p>
                    <dl className="mt-0.5 grid grid-cols-2 gap-y-0.5">
                      <dt className="text-[var(--color-ink-faint)]">Actual billed</dt><dd className="tnum text-right">{f.actualHours} h</dd>
                      <dt className="text-[var(--color-ink-faint)]">Scheduled (not billed)</dt><dd className="tnum text-right">{f.scheduledHours} h</dd>
                      <dt className="text-[var(--color-ink-faint)]">This session</dt><dd className="tnum text-right">+{f.thisHours} h</dd>
                      <dt className="text-[var(--color-ink-faint)]">Authorised</dt><dd className="tnum text-right">{f.authorizedHours ?? "—"}{f.authorizedHours ? " h" : ""}</dd>
                      <dt className="font-medium">Remaining after</dt>
                      <dd className={`tnum text-right font-medium ${f.remainingAfterHours !== null && Number(f.remainingAfterHours) < 0 ? "text-[var(--color-pace-over)]" : ""}`}>
                        {f.remainingAfterHours ?? "—"}{f.remainingAfterHours ? " h" : ""}
                      </dd>
                    </dl>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}

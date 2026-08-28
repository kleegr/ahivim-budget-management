"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarX2, Save } from "lucide-react";
import type { PlanningSeriesRow } from "@/lib/data/planning-queries";
import {
  schedulePreviewRequiresOverride,
  type PlanningSchedulePreview,
} from "@/lib/business/schedule-preflight";
import { SchedulePreflightSummary } from "./create-session-modal";
import {
  ModalShell,
  WEEKDAYS,
  durationFromTimes,
  send,
  type Picker,
  type ProgramPicker,
} from "./shared";
import { dec } from "@/lib/money";

export default function EditServiceScheduleModal({
  row,
  today,
  employees,
  individuals,
  programs,
  onClose,
  onUpdated,
}: {
  row: PlanningSeriesRow;
  today: string;
  employees: Picker[];
  individuals: Picker[];
  programs: ProgramPicker[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(row.employeeId ?? "");
  const [programId, setProgramId] = useState(row.programId ?? "");
  const [picked, setPicked] = useState(new Set(row.participantIds));
  const [individualSearch, setIndividualSearch] = useState("");
  const [frequency, setFrequency] = useState<"weekly" | "daily">(row.frequency === "daily" ? "daily" : "weekly");
  const [interval, setInterval] = useState(String(row.interval));
  const [weekdays, setWeekdays] = useState(new Set(row.weekdays));
  const [startDate, setStartDate] = useState(row.startDate);
  const [endDate, setEndDate] = useState(row.endDate);
  const [startTime, setStartTime] = useState(row.startTime ?? "");
  const [endTime, setEndTime] = useState(row.endTime ?? "");
  const [duration, setDuration] = useState(row.durationHours);
  const [serviceType, setServiceType] = useState(row.serviceType ?? "");
  const [notes, setNotes] = useState(row.notes ?? "");
  const [applyFromDate, setApplyFromDate] = useState(today);
  const [reason, setReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<PlanningSchedulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewSequence = useRef(0);

  const timeDuration = durationFromTimes(startTime || null, endTime || null);
  const effectiveDuration = timeDuration || duration.trim();
  const individualIds = useMemo(() => [...picked], [picked]);
  const recurrenceInterval = Math.max(1, Math.floor(Number(interval) || 1));
  const previewPayload = useMemo(() => ({
    employeeId: employeeId || null,
    programId,
    individualIds,
    sessionDate: startDate,
    startTime: startTime || null,
    endTime: endTime || null,
    durationHours: effectiveDuration,
    editSeriesId: row.id,
    recurrence: {
      frequency,
      interval: recurrenceInterval,
      weekdays: [...weekdays],
      startDate,
      endDate,
      applyFromDate,
    },
  }), [
    applyFromDate,
    effectiveDuration,
    employeeId,
    endDate,
    endTime,
    frequency,
    individualIds,
    programId,
    recurrenceInterval,
    row.id,
    startDate,
    startTime,
    weekdays,
  ]);
  const filteredIndividuals = useMemo(() => {
    const query = individualSearch.trim().toLocaleLowerCase();
    return query
      ? individuals.filter((individual) => individual.label.toLocaleLowerCase().includes(query))
      : individuals;
  }, [individualSearch, individuals]);
  const hasWarnings = preview
    ? schedulePreviewRequiresOverride(preview, { recurring: true, selectedEmployeeId: employeeId })
    : false;
  const previewOccurrenceCount = preview?.seriesAuthorization?.occurrenceCount
    ?? preview?.individualConflicts.occurrenceCount
    ?? 0;
  const previewTotalPlannedHours = previewOccurrenceCount > 0
    && Number.isFinite(Number(effectiveDuration))
    ? dec(effectiveDuration).times(previewOccurrenceCount).toString()
    : null;

  useEffect(() => {
    const sequence = ++previewSequence.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelPreview = () => {
      if (timer) clearTimeout(timer);
      if (previewSequence.current === sequence) previewSequence.current += 1;
    };
    const valid = programId
      && individualIds.length > 0
      && effectiveDuration
      && startDate
      && endDate >= startDate
      && applyFromDate
      && (frequency !== "weekly" || weekdays.size > 0);
    setPreview(null);
    if (!valid) {
      setPreviewBusy(false);
      return cancelPreview;
    }
    setPreviewBusy(true);
    timer = setTimeout(async () => {
      const response = await send("POST", "/api/schedule/preview", previewPayload);
      if (sequence !== previewSequence.current) return;
      setPreview(response.ok ? response.data as PlanningSchedulePreview : null);
      setPreviewBusy(false);
    }, 350);
    return cancelPreview;
  }, [
    applyFromDate,
    effectiveDuration,
    endDate,
    frequency,
    individualIds.length,
    previewPayload,
    programId,
    startDate,
    weekdays.size,
  ]);

  function toggleIndividual(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleWeekday(day: number) {
    setWeekdays((current) => {
      const next = new Set(current);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  async function update() {
    setError(null);
    if (!programId) return setError("Choose a program.");
    if (individualIds.length === 0) return setError("Choose at least one individual.");
    if (frequency === "weekly" && weekdays.size === 0) return setError("Choose at least one weekday.");
    if (!effectiveDuration) return setError("Enter a duration, or a valid start and end time.");
    if (!startDate || !endDate || endDate < startDate) return setError("Give a valid effective date range.");
    setBusy(true);
    const preflightResponse = await send("POST", "/api/schedule/preview", previewPayload);
    if (!preflightResponse.ok) {
      setBusy(false);
      return setError(preflightResponse.error ?? "Could not check this schedule. Try again.");
    }
    const livePreview = preflightResponse.data as PlanningSchedulePreview;
    setPreview(livePreview);
    if (livePreview.validationMessage) {
      setBusy(false);
      return setError(livePreview.validationMessage);
    }
    if (schedulePreviewRequiresOverride(livePreview, { recurring: true, selectedEmployeeId: employeeId }) && !reason.trim()) {
      setBusy(false);
      return setError("Review the schedule warnings and add a written override reason before saving.");
    }
    const response = await send("PATCH", `/api/schedule/series/${row.id}`, {
      action: "update",
      employeeId: employeeId || null,
      programId,
      individualIds,
      frequency,
      interval: recurrenceInterval,
      weekdays: [...weekdays],
      startDate,
      endDate,
      startTime: startTime || null,
      endTime: endTime || null,
      durationHours: effectiveDuration,
      serviceType: serviceType || null,
      notes: notes || null,
      status: "active",
      applyFromDate,
      overrideReason: reason.trim() || null,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (!response.ok) return setError(response.error ?? "Could not update the schedule.");
    onUpdated();
  }

  async function cancelSchedule() {
    setError(null);
    if (!reason.trim()) return setError("Add a reason before ending this schedule.");
    setBusy(true);
    const response = await send("PATCH", `/api/schedule/series/${row.id}`, {
      action: "cancel",
      reason: reason.trim(),
    });
    setBusy(false);
    if (!response.ok) return setError(response.error ?? "Could not end the schedule.");
    onUpdated();
  }

  return (
    <ModalShell title="Edit service schedule" onClose={onClose} wide>
      <div className="space-y-4">
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="font-medium">Program</span>
              <select value={programId} onChange={(event) => setProgramId(event.target.value)} className="select mt-1 w-full">
                <option value="">Choose program</option>
                {programs.map((program) => <option key={program.id} value={program.id}>{program.name} ({program.code})</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium">Employee</span>
              <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="select mt-1 w-full">
                <option value="">Employee needed</option>
                {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}</option>)}
              </select>
            </label>
            <div className="text-sm">
              <span className="font-medium">Individuals</span>
              <input
                type="search"
                value={individualSearch}
                onChange={(event) => setIndividualSearch(event.target.value)}
                placeholder="Search individuals"
                className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 text-sm"
              />
              <div className="scroll-thin mt-1 max-h-44 overflow-y-auto rounded border border-[var(--color-rule)] p-1">
                {filteredIndividuals.map((individual) => (
                  <label key={individual.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-[var(--color-paper)]">
                    <input type="checkbox" checked={picked.has(individual.id)} onChange={() => toggleIndividual(individual.id)} />
                    <span>{individual.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="block text-sm">
              <span className="font-medium">Service type <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span></span>
              <input value={serviceType} onChange={(event) => setServiceType(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 text-sm" />
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2 text-sm">
              <label className="min-w-36 flex-1">Recurrence
                <select value={frequency} onChange={(event) => setFrequency(event.target.value as "weekly" | "daily")} className="select mt-1 w-full">
                  <option value="weekly">Weekly</option>
                  <option value="daily">Daily</option>
                </select>
              </label>
              <label className="w-24">Every
                <input type="number" min={1} value={interval} onChange={(event) => setInterval(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 text-sm" />
              </label>
              <span className="pb-2 text-xs text-[var(--color-ink-faint)]">{frequency === "weekly" ? "week(s)" : "day(s)"}</span>
            </div>
            {frequency === "weekly" ? (
              <div>
                <p className="text-sm font-medium">Days</p>
                <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Weekly service days">
                  {WEEKDAYS.map((weekday, day) => (
                    <button
                      key={weekday}
                      type="button"
                      aria-pressed={weekdays.has(day)}
                      onClick={() => toggleWeekday(day)}
                      className={`h-8 min-w-10 rounded px-2 text-xs ${weekdays.has(day) ? "bg-[var(--color-primary)] text-white" : "border border-[var(--color-rule-strong)] bg-white"}`}
                    >
                      {weekday.slice(0, 3)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <label>Effective start<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2" /></label>
              <label>Effective end<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2" /></label>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <label>Start<input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2" /></label>
              <label>End<input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2" /></label>
              <label>Hours<input type="number" min={0} step="any" value={timeDuration || duration} disabled={Boolean(timeDuration)} onChange={(event) => setDuration(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2 disabled:bg-[var(--color-paper)]" /></label>
            </div>
            <label className="block text-sm">Apply changes from
              <input type="date" min={today} value={applyFromDate} onChange={(event) => setApplyFromDate(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2" />
            </label>
            <label className="block text-sm">Notes
              <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-2" />
            </label>
            <label className="block text-sm">Change reason <span className={`font-normal ${hasWarnings ? "text-[var(--color-pace-near)]" : "text-[var(--color-ink-faint)]"}`}>{hasWarnings ? "(required for warnings)" : "(audit log)"}</span>
              <input value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3" />
            </label>
          </div>
        </div>

        <section aria-label="Schedule preflight" className="border-t border-[var(--color-rule)] pt-3">
          {previewBusy ? <p role="status" className="text-sm text-[var(--color-ink-soft)]">Checking every proposed visit...</p> : null}
          {preview?.validationMessage ? (
            <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
              {preview.validationMessage}
            </p>
          ) : preview ? (
            <SchedulePreflightSummary
              preview={preview}
              isGroup={individualIds.length > 1}
              recurring
              occurrenceCount={previewOccurrenceCount}
              totalPlannedHours={previewTotalPlannedHours}
              selectedEmployeeId={employeeId}
            />
          ) : !previewBusy ? (
            <p className="text-sm text-[var(--color-ink-soft)]">Complete the schedule details to check authorization hours, assignments, and conflicts.</p>
          ) : null}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-rule)] pt-3">
          <div>
            {!confirmCancel ? (
              <button type="button" onClick={() => setConfirmCancel(true)} className="btn btn-sm btn-ghost text-[var(--color-danger)]">
                <CalendarX2 aria-hidden className="h-4 w-4" /> End schedule
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button type="button" disabled={busy} onClick={cancelSchedule} className="btn btn-sm btn-danger">
                  <CalendarX2 aria-hidden className="h-4 w-4" /> Confirm end
                </button>
                <button type="button" onClick={() => setConfirmCancel(false)} className="btn btn-sm btn-ghost">Keep active</button>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn btn-sm btn-secondary">Cancel</button>
            <button type="button" disabled={busy} onClick={update} className="btn btn-sm btn-primary">
              <Save aria-hidden className="h-4 w-4" /> {busy ? "Saving..." : "Save schedule"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

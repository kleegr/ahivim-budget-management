"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarOff, Check, CircleHelp, Clock3, UserMinus } from "lucide-react";
import type {
  EmployeeAvailability,
  EmployeeAvailabilityResult,
} from "@/lib/data/employee-availability";
import type { SeriesAuthorizationResult } from "@/lib/data/series-authorization";
import { projectSeries } from "@/lib/business/planning-projection";
import { MAX_SERIES_OCCURRENCES } from "@/lib/business/scheduling";
import {
  schedulePreviewRequiresOverride,
  type PlanningSchedulePreview,
} from "@/lib/business/schedule-preflight";
import {
  send, ModalShell, addDays, weekday, durationFromTimes, humanDate, WEEKDAYS,
  classifyWarningCode, type WarningCategory,
  type Picker, type ProgramPicker,
} from "./shared";
import { dec, formatHours } from "@/lib/money";

const SERIES_OCCURRENCE_LIMIT_MESSAGE = `A recurring schedule can include up to ${MAX_SERIES_OCCURRENCES} visits. Shorten the date range or use a longer interval.`;

/** Create a one-time or recurring session, with a live forecast + warnings. */
export default function CreateSessionModal({
  defaultDate,
  employees,
  individuals,
  programs,
  initialMode = "one_time",
  initialEmployeeId = "",
  initialIndividualId = "",
  initialProgramId = "",
  onClose,
  onCreated,
}: {
  defaultDate: string;
  employees: Picker[];
  individuals: Picker[];
  programs: ProgramPicker[];
  initialMode?: "one_time" | "recurring";
  initialEmployeeId?: string;
  initialIndividualId?: string;
  initialProgramId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [recurring, setRecurring] = useState(initialMode === "recurring");
  const [programId, setProgramId] = useState(initialProgramId);
  const [employeeId, setEmployeeId] = useState(initialEmployeeId);
  const [picked, setPicked] = useState<Set<string>>(
    new Set(initialIndividualId ? [initialIndividualId] : []),
  );
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
  const [endDate, setEndDate] = useState(addDays(defaultDate, 364));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverRequiresOverride, setServerRequiresOverride] = useState(false);
  const [preview, setPreview] = useState<PlanningSchedulePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const individualIds = useMemo(() => [...picked], [picked]);
  const timeDuration = durationFromTimes(startTime || null, endTime || null);
  const effectiveDuration = timeDuration || duration.trim();
  const recurrenceInterval = Math.max(1, Math.floor(Number(interval) || 1));
  const seriesProjection = useMemo(() => projectSeries({
    frequency,
    interval: recurrenceInterval,
    weekdays: [...weekdays],
    startDate: date,
    endDate,
    max: MAX_SERIES_OCCURRENCES + 1,
  }, effectiveDuration), [date, effectiveDuration, endDate, frequency, recurrenceInterval, weekdays]);
  const occurrenceCount = recurring ? seriesProjection.occurrenceCount : 1;
  const totalPlannedHours = recurring ? seriesProjection.totalHours : effectiveDuration || null;
  const localValidationMessage = recurring && occurrenceCount > MAX_SERIES_OCCURRENCES
    ? SERIES_OCCURRENCE_LIMIT_MESSAGE
    : null;

  // Live preview (debounced).
  useEffect(() => {
    let cancelled = false;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setPreview(null);
    if (!programId || individualIds.length === 0 || !date || !effectiveDuration) {
      setPreviewBusy(false);
      return;
    }
    setPreviewBusy(true);
    previewTimer.current = setTimeout(async () => {
      const res = await send("POST", "/api/schedule/preview", {
        employeeId: employeeId || null,
        programId,
        individualIds,
        sessionDate: date,
        startTime: startTime || null,
        endTime: endTime || null,
        durationHours: effectiveDuration,
        recurrence: recurring ? {
          frequency,
          interval: recurrenceInterval,
          weekdays: [...weekdays],
          endDate,
        } : null,
      });
      if (cancelled) return;
      setPreview(res.ok ? res.data as PlanningSchedulePreview : null);
      setPreviewBusy(false);
      if (res.ok) setServerRequiresOverride(false);
    }, 350);
    return () => {
      cancelled = true;
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [
    programId, employeeId, individualIds, date, startTime, endTime, effectiveDuration,
    recurring, frequency, recurrenceInterval, weekdays, endDate,
  ]);

  const filteredIndividuals = useMemo(() => {
    const q = indSearch.trim().toLowerCase();
    return q ? individuals.filter((i) => i.label.toLowerCase().includes(q)) : individuals;
  }, [individuals, indSearch]);

  const availability = preview?.employeeAvailability ?? null;
  const rankedEmployees = useMemo(() => {
    const pickerById = new Map(employees.map((employee) => [employee.id, employee]));
    if (!availability) {
      return employees.map((employee) => ({ employee, availability: null as EmployeeAvailability | null }));
    }

    const seen = new Set<string>();
    const ranked = availability.employees.map((signal) => {
      seen.add(signal.employeeId);
      return {
        employee: pickerById.get(signal.employeeId) ?? {
          id: signal.employeeId,
          label: signal.employeeName,
        },
        availability: signal as EmployeeAvailability | null,
      };
    });
    for (const employee of employees) {
      if (!seen.has(employee.id)) ranked.push({ employee, availability: null });
    }
    return ranked;
  }, [availability, employees]);

  const seriesAuthorization = recurring ? preview?.seriesAuthorization ?? null : null;
  const validationMessage = localValidationMessage ?? preview?.validationMessage ?? null;
  const hasWarnings = serverRequiresOverride || Boolean(preview
    && schedulePreviewRequiresOverride(preview, { recurring, selectedEmployeeId: employeeId }));

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
    if (recurring && frequency === "weekly" && weekdays.size === 0) {
      setError("Choose at least one weekday for a weekly schedule.");
      return;
    }
    if (recurring && occurrenceCount === 0) {
      setError("The recurrence does not contain any dates. Check the start and end dates.");
      return;
    }
    if (validationMessage) {
      setError(validationMessage);
      return;
    }
    if (hasWarnings && !overrideReason.trim()) {
      setError("Enter an override reason before saving a schedule with warnings.");
      return;
    }
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
        interval: recurrenceInterval,
        weekdays: [...weekdays],
        startDate: date,
        endDate,
      });
    } else {
      res = await send("POST", "/api/schedule/sessions", { ...common, sessionDate: date });
    }
    setBusy(false);
    if (!res.ok) {
      if (res.error?.includes("written override reason")) setServerRequiresOverride(true);
      setError(res.error ?? "Could not save.");
      return;
    }
    onCreated();
  }

  const selectedProgram = programs.find((p) => p.id === programId);
  const isGroup = individualIds.length > 1;

  return (
    <ModalShell title={recurring ? "New service schedule" : "New one-time session"} onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Left: form */}
        <div className="space-y-3">
          {error ? <p role="alert" className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">{error}</p> : null}

          <div className="inline-flex overflow-hidden rounded border border-[var(--color-rule-strong)] text-sm" role="group" aria-label="Schedule type">
            <button type="button" aria-pressed={!recurring} onClick={() => setRecurring(false)} className={`px-3 py-1 ${!recurring ? "bg-[var(--color-primary)] text-white" : "bg-white"}`}>One-time session</button>
            <button type="button" aria-pressed={recurring} onClick={() => setRecurring(true)} className={`px-3 py-1 ${recurring ? "bg-[var(--color-primary)] text-white" : "bg-white"}`}>Recurring schedule</button>
          </div>

          <label className="block text-sm">
            <span className="font-medium">Program</span>
            <select value={programId} onChange={(e) => setProgramId(e.target.value)} className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm">
              <option value="">Choose…</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}{p.isGroupCapable ? " (group)" : ""}</option>)}
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
                <div className="flex flex-wrap gap-1" role="group" aria-label="Weekly service days">
                  {WEEKDAYS.map((w, n) => (
                    <button key={w} type="button" aria-pressed={weekdays.has(n)} onClick={() => toggleWeekday(n)} className={`rounded px-2 py-1 text-xs ${weekdays.has(n) ? "bg-[var(--color-primary)] text-white" : "border border-[var(--color-rule-strong)] bg-white"}`}>{w}</button>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 text-sm">
                <label>Start<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
                <label>End<input type="date" min={date} value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
              </div>
              <p className={`text-xs ${occurrenceCount === 0 ? "text-[var(--color-pace-over)]" : "text-[var(--color-ink-soft)]"}`} role="status">
                {frequency === "weekly" && weekdays.size === 0
                  ? "No weekdays selected"
                  : occurrenceCount === 0
                    ? "No visits in this date range"
                    : `${occurrenceCount} visit${occurrenceCount === 1 ? "" : "s"}${totalPlannedHours ? ` · ${formatHours(totalPlannedHours)} h per individual` : ""}`}
              </p>
              {validationMessage ? <p className="mt-1 text-xs font-medium text-[var(--color-pace-over)]">{validationMessage}</p> : null}
            </div>
          )}

          <div className="flex flex-wrap gap-2 text-sm">
            <label>Start<input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
            <label>End<input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="mt-0.5 block rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm" /></label>
            <label>Duration (h)<input type="number" step="any" min={0} value={timeDuration || duration} disabled={Boolean(timeDuration)} onChange={(e) => setDuration(e.target.value)} placeholder="e.g. 2" className="mt-0.5 block w-24 rounded border border-[var(--color-rule-strong)] px-2 py-1 text-sm disabled:bg-[var(--color-paper)] disabled:text-[var(--color-ink-soft)]" /></label>
          </div>

          <label className="block text-sm">
            <span className="font-medium">Employee <span className="text-[var(--color-ink-faint)]">(optional — leave blank to leave unassigned)</span></span>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm">
              <option value="">Unassigned</option>
              {rankedEmployees.map(({ employee, availability: signal }) => (
                <option key={employee.id} value={employee.id}>
                  {employee.label}{signal ? ` — ${employeeAvailabilityLabel(signal, availability!.timeRangeKnown, availability!.occurrenceCount)}` : ""}
                </option>
              ))}
            </select>
          </label>

          {availability ? (
            <EmployeeAvailabilityAssist
              availability={availability}
              selectedEmployeeId={employeeId}
              sessionDate={date}
              onSelect={setEmployeeId}
            />
          ) : null}

          <label className="block text-sm">
            <span className="font-medium">Service type <span className="text-[var(--color-ink-faint)]">(optional)</span></span>
            <input value={serviceType} onChange={(e) => setServiceType(e.target.value)} placeholder="e.g. respite, community habilitation" className="input mt-1 w-full" />
          </label>

          <label className="block text-sm">
            <span className="font-medium">Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input mt-1 w-full py-2" />
          </label>

          {hasWarnings ? (
            <label className="block text-sm">
              <span className="font-medium text-[var(--color-pace-near)]">Override reason (warnings present)</span>
              <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why schedule despite the warnings" className="input mt-1 w-full border-[var(--color-pace-near)]" />
            </label>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button type="button" disabled={busy} aria-busy={busy} onClick={submit} className="btn btn-primary">
              {busy ? "Saving…" : recurring ? "Create schedule" : "Add session"}
            </button>
          </div>
        </div>

        {/* Right: live forecast + warnings */}
        <div className="space-y-3">
          {previewBusy ? <p role="status" className="text-sm text-[var(--color-ink-soft)]">Checking this schedule...</p> : null}
          {preview && (!recurring || (seriesAuthorization && seriesAuthorization.occurrenceCount > 0)) ? (
            <SchedulePreflightSummary
              preview={preview}
              isGroup={isGroup}
              recurring={recurring}
              occurrenceCount={occurrenceCount}
              totalPlannedHours={totalPlannedHours}
              selectedEmployeeId={employeeId}
            />
          ) : null}

          {preview && recurring && seriesAuthorization ? (
            <SeriesAuthorizationForecast projection={seriesAuthorization} />
          ) : null}

          {preview && !recurring && preview.forecast.length > 0 ? (
            <div className="rounded-lg border border-[var(--color-rule)] p-3">
              <p className="eyebrow">Forecast against authorization</p>
              <div className="mt-2 space-y-2">
                {preview.forecast.map((f) => (
                  <div key={f.individualId} className="text-xs">
                    <p className="font-medium">{f.individualName}</p>
                    {f.sourceAmbiguous ? (
                      <p className="mt-1 font-medium text-[var(--color-pace-near)]">
                        {f.sourceCandidateCount} active plans list this program. The primary plan is shown; their hours are not added together.
                      </p>
                    ) : null}
                    {f.authorizationAmbiguous ? (
                      <p className="mt-1 text-[var(--color-ink-soft)]">
                        {f.authorizationCount} overlapping authorizations need review. Combined remaining hours are hidden.
                      </p>
                    ) : (
                      <dl className="mt-0.5 grid grid-cols-2 gap-y-0.5">
                        <dt className="text-[var(--color-ink-faint)]">Used hours</dt><dd className="tnum text-right">{f.actualHours} h</dd>
                        <dt className="text-[var(--color-ink-faint)]">Already scheduled</dt><dd className="tnum text-right">{f.scheduledHours} h</dd>
                        <dt className="text-[var(--color-ink-faint)]">This session</dt>
                        <dd className="tnum text-right">+{formatHours(f.thisHours)} h</dd>
                        <dt className="text-[var(--color-ink-faint)]">Authorized</dt><dd className="tnum text-right">{f.authorizedHours ?? "—"}{f.authorizedHours ? " h" : ""}</dd>
                        <dt className="font-medium">Remaining after</dt>
                        <dd className={`tnum text-right font-medium ${f.remainingAfterHours !== null && Number(f.remainingAfterHours) < 0 ? "text-[var(--color-pace-over)]" : ""}`}>
                          {f.remainingAfterHours === null ? "—" : `${formatHours(f.remainingAfterHours)} h`}
                        </dd>
                      </dl>
                    )}
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

function SeriesAuthorizationForecast({ projection }: { projection: SeriesAuthorizationResult }) {
  return (
    <div className="rounded-lg border border-[var(--color-rule)] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="eyebrow">Series hours by authorization period</p>
        <span className="text-xs text-[var(--color-ink-faint)]">
          {projection.occurrenceCount} visit{projection.occurrenceCount === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-2 space-y-3">
        {projection.individuals.map((individual) => (
          <section key={individual.individualId} aria-label={`${individual.individualName} authorization projection`}>
            <p className="text-xs font-semibold">{individual.individualName}</p>
            {individual.periods.map((period) => {
              const over = period.remainingAfterHours !== null && dec(period.remainingAfterHours).isNegative();
              return (
                <div key={period.periodId} className="mt-1.5 border-t border-[var(--color-rule)] pt-1.5 text-xs">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="font-medium">{period.periodLabel}</span>
                    <span className="text-[var(--color-ink-faint)]">{period.startDate} to {period.endDate}</span>
                  </div>
                  <dl className="mt-1 grid grid-cols-2 gap-y-0.5">
                    <dt className="text-[var(--color-ink-faint)]">Used hours</dt>
                    <dd className="tnum text-right">
                      {period.actualHours === null ? "Unavailable" : `${formatHours(period.actualHours)} h`}
                    </dd>
                    <dt className="text-[var(--color-ink-faint)]">Already scheduled</dt>
                    <dd className="tnum text-right">
                      {period.scheduledHours === null ? "Unavailable" : `${formatHours(period.scheduledHours)} h`}
                    </dd>
                    <dt className="text-[var(--color-ink-faint)]">Series ({period.seriesOccurrenceCount})</dt>
                    <dd className="tnum text-right">+{formatHours(period.seriesHours)} h</dd>
                    <dt className="text-[var(--color-ink-faint)]">Authorized</dt>
                    <dd className="tnum text-right">{formatHours(period.authorizedHours)} h</dd>
                    <dt className="font-medium">Remaining after series</dt>
                    <dd className={`tnum text-right font-medium ${over || !period.calculationSafe ? "text-[var(--color-pace-over)]" : ""}`}>
                      {period.remainingAfterHours === null
                        ? "Unavailable"
                        : `${formatHours(period.remainingAfterHours)} h`}
                    </dd>
                  </dl>
                  {!period.calculationSafe ? (
                    <p className="mt-1 text-[var(--color-pace-over)]">Overlapping authorization dates</p>
                  ) : null}
                  {period.sourceAmbiguous ? (
                    <p className="mt-1 font-medium text-[var(--color-pace-near)]">
                      {period.sourceCandidateCount} active plans list this program. The primary plan is shown; their hours are not added together.
                    </p>
                  ) : null}
                </div>
              );
            })}

            {individual.uncoveredOccurrenceCount > 0 ? (
              <p className="mt-1.5 text-xs font-medium text-[var(--color-pace-over)]">
                No authorization: {individual.uncoveredOccurrenceCount} visit{individual.uncoveredOccurrenceCount === 1 ? "" : "s"} · {formatHours(individual.uncoveredHours)} h
              </p>
            ) : null}
            {individual.ambiguousOccurrenceCount > 0 ? (
              <p className="mt-1 text-xs font-medium text-[var(--color-pace-over)]">
                Overlapping authorizations: {individual.ambiguousOccurrenceCount} visit{individual.ambiguousOccurrenceCount === 1 ? "" : "s"} · {formatHours(individual.ambiguousHours)} h
              </p>
            ) : null}
          </section>
        ))}
        {projection.occurrenceCount === 0 ? (
          <p className="text-xs text-[var(--color-pace-over)]">No visits in this recurrence</p>
        ) : null}
      </div>
    </div>
  );
}

function employeeAvailabilityLabel(
  employee: EmployeeAvailability,
  timeRangeKnown: boolean,
  occurrenceCount: number,
): string {
  const missingAssignments = Math.max(0, occurrenceCount - employee.assignedOccurrenceCount);
  const busy = employee.conflictingOccurrenceCount > 0
    ? `; busy on ${employee.conflictingOccurrenceCount} visit${employee.conflictingOccurrenceCount === 1 ? "" : "s"}`
    : "";
  if (!employee.assignedToAll) {
    return `Not assigned on ${missingAssignments} visit${missingAssignments === 1 ? "" : "s"}${busy}`;
  }
  if (!timeRangeKnown) return "Assigned; set start and end times";
  if (employee.unavailableOccurrenceCount > 0) {
    return `Unavailable on ${employee.unavailableOccurrenceCount} visit${employee.unavailableOccurrenceCount === 1 ? "" : "s"}`;
  }
  if (employee.outsideDeclaredAvailabilityOccurrenceCount > 0) {
    return `Outside working hours on ${employee.outsideDeclaredAvailabilityOccurrenceCount} visit${employee.outsideDeclaredAvailabilityOccurrenceCount === 1 ? "" : "s"}`;
  }
  if (employee.conflictingOccurrenceCount > 0) {
    return `Busy on ${employee.conflictingOccurrenceCount} visit${employee.conflictingOccurrenceCount === 1 ? "" : "s"}`;
  }
  if (employee.undeclaredAvailabilityOccurrenceCount > 0) {
    return `Available; hours not entered for ${employee.undeclaredAvailabilityOccurrenceCount} visit${employee.undeclaredAvailabilityOccurrenceCount === 1 ? "" : "s"}`;
  }
  return "Available";
}

function EmployeeAvailabilityAssist({
  availability,
  selectedEmployeeId,
  sessionDate,
  onSelect,
}: {
  availability: EmployeeAvailabilityResult;
  selectedEmployeeId: string;
  sessionDate: string;
  onSelect: (employeeId: string) => void;
}) {
  const available = availability.employees.filter((employee) => employee.available);
  const busy = availability.employees.filter((employee) =>
    employee.assignedToAll && employee.conflictingOccurrenceCount > 0);
  const unavailable = availability.employees.filter((employee) =>
    employee.assignedToAll && employee.unavailableOccurrenceCount > 0);
  const outsideHours = availability.employees.filter((employee) =>
    employee.assignedToAll && employee.outsideDeclaredAvailabilityOccurrenceCount > 0);
  const hoursNotEntered = availability.employees.filter((employee) =>
    employee.available && employee.undeclaredAvailabilityOccurrenceCount > 0);
  const notAssigned = availability.employees.filter((employee) => !employee.assignedToAll);
  const visibleAvailable = available.slice(0, 6);

  return (
    <section className="rounded border border-[var(--color-rule)] bg-[var(--color-paper)] p-2" aria-labelledby="available-employees-heading">
      <div className="flex items-baseline justify-between gap-2">
        <p id="available-employees-heading" className="text-xs font-semibold">Available employees</p>
        <span className="text-xs text-[var(--color-ink-faint)]">
          {availability.occurrenceCount > 1
            ? `${availability.occurrenceCount} visits`
            : humanDate(sessionDate)}
        </span>
      </div>

      {!availability.timeRangeKnown ? (
        <p className="mt-1 text-xs text-[var(--color-pace-near)]">Start and end times required</p>
      ) : available.length === 0 ? (
        <p className="mt-1 text-xs text-[var(--color-pace-near)]">No fully assigned, conflict-free employee</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {visibleAvailable.map((employee) => (
            <button
              key={employee.employeeId}
              type="button"
              aria-pressed={selectedEmployeeId === employee.employeeId}
              onClick={() => onSelect(employee.employeeId)}
              className={`inline-flex min-w-0 items-center gap-1 rounded border px-2 py-1 text-xs ${
                selectedEmployeeId === employee.employeeId
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                  : "border-[var(--color-rule-strong)] bg-white text-[var(--color-ink)] hover:border-[var(--color-primary)]"
              }`}
            >
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{employee.employeeName}</span>
            </button>
          ))}
          {available.length > visibleAvailable.length ? (
            <span className="self-center text-xs text-[var(--color-ink-faint)]">+{available.length - visibleAvailable.length} more</span>
          ) : null}
        </div>
      )}

      {availability.timeRangeKnown && busy.length > 0 ? (
        <AvailabilityStatus
          icon="busy"
          label="Busy"
          detail={summarizeEmployees(busy, (employee) =>
            `${employee.employeeName} (${employee.conflictingOccurrenceCount}/${availability.occurrenceCount} visits)`)}
        />
      ) : null}
      {availability.timeRangeKnown && unavailable.length > 0 ? (
        <AvailabilityStatus
          icon="unavailable"
          label="Unavailable"
          detail={summarizeEmployees(unavailable, (employee) =>
            `${employee.employeeName} (${employee.unavailableOccurrenceCount}/${availability.occurrenceCount} visits)`) }
        />
      ) : null}
      {availability.timeRangeKnown && outsideHours.length > 0 ? (
        <AvailabilityStatus
          icon="outside-hours"
          label="Outside working hours"
          detail={summarizeEmployees(outsideHours, (employee) =>
            `${employee.employeeName} (${employee.outsideDeclaredAvailabilityOccurrenceCount}/${availability.occurrenceCount} visits)`) }
        />
      ) : null}
      {availability.timeRangeKnown && hoursNotEntered.length > 0 ? (
        <AvailabilityStatus
          icon="not-entered"
          label="Hours not entered"
          detail={summarizeEmployees(hoursNotEntered, (employee) => employee.employeeName)}
        />
      ) : null}
      {notAssigned.length > 0 ? (
        <AvailabilityStatus
          icon="not-assigned"
          label="Not assigned to all"
          detail={summarizeEmployees(notAssigned, (employee) =>
            `${employee.employeeName} (${availability.occurrenceCount - employee.assignedOccurrenceCount} missing)`)}
        />
      ) : null}
    </section>
  );
}

function AvailabilityStatus({
  icon,
  label,
  detail,
}: {
  icon: "busy" | "not-assigned" | "unavailable" | "outside-hours" | "not-entered";
  label: string;
  detail: string;
}) {
  const Icon = icon === "unavailable"
    ? CalendarOff
    : icon === "not-assigned"
      ? UserMinus
      : icon === "not-entered"
        ? CircleHelp
        : Clock3;
  return (
    <p className="mt-1 flex items-start gap-1 text-xs text-[var(--color-ink-faint)]">
      <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span><span className="font-medium text-[var(--color-ink-soft)]">{label}:</span> {detail}</span>
    </p>
  );
}

function summarizeEmployees(
  employees: EmployeeAvailability[],
  label: (employee: EmployeeAvailability) => string,
): string {
  const visible = employees.slice(0, 3).map(label).join(", ");
  const remainder = employees.length - 3;
  return remainder > 0 ? `${visible} +${remainder}` : visible;
}

/**
 * Prominent, colour-coded read-out of the preview's budget impact: is the
 * authorization valid, are there enough remaining hours, is there a conflict —
 * and what each individual would have left after this session. Surfaces only
 * what the preview endpoint already returned; no money maths here.
 */
export function SchedulePreflightSummary({
  preview,
  isGroup,
  recurring,
  occurrenceCount,
  totalPlannedHours,
  selectedEmployeeId,
}: {
  preview: PlanningSchedulePreview;
  isGroup: boolean;
  recurring: boolean;
  occurrenceCount: number;
  totalPlannedHours: string | null;
  selectedEmployeeId: string;
}) {
  const cats: Record<WarningCategory, string[]> = { budget: [], conflict: [], other: [] };
  for (const warning of preview.warnings) {
    const category = classifyWarningCode(warning.code);
    if (recurring && category === "budget") continue;
    cats[category].push(warning.message);
  }

  const seriesAuthorizationWarnings: string[] = [];
  for (const individual of preview.seriesAuthorization?.individuals ?? []) {
    const sourceAmbiguousPeriods = individual.periods.filter((period) => period.sourceAmbiguous);
    if (sourceAmbiguousPeriods.length > 0) {
      const sourceCandidateCount = Math.max(
        ...sourceAmbiguousPeriods.map((period) => period.sourceCandidateCount),
      );
      seriesAuthorizationWarnings.push(
        `${individual.individualName} has ${sourceCandidateCount} active plans for this program. The primary plan is used and their hours are not added together.`,
      );
    }
    if (individual.uncoveredOccurrenceCount > 0) {
      seriesAuthorizationWarnings.push(
        `${individual.individualName} has ${individual.uncoveredOccurrenceCount} visit${individual.uncoveredOccurrenceCount === 1 ? "" : "s"} without an authorization.`,
      );
    }
    if (individual.ambiguousOccurrenceCount > 0) {
      seriesAuthorizationWarnings.push(
        `${individual.individualName} has ${individual.ambiguousOccurrenceCount} visit${individual.ambiguousOccurrenceCount === 1 ? "" : "s"} covered by overlapping authorizations.`,
      );
    } else if (individual.periods.some((period) => !period.calculationSafe)) {
      seriesAuthorizationWarnings.push(
        `${individual.individualName} has overlapping authorization periods, so remaining hours cannot be calculated safely.`,
      );
    }
  }
  const employeeSeriesWarnings: string[] = [];
  const employeeReadiness = selectedEmployeeId
    ? preview.employeeAvailability.employees.find((employee) => employee.employeeId === selectedEmployeeId)
    : null;
  if (employeeReadiness) {
    const missingAssignments = occurrenceCount - employeeReadiness.assignedOccurrenceCount;
    if (missingAssignments > 0) {
      employeeSeriesWarnings.push(
        `The selected employee is not assigned for ${missingAssignments} visit${missingAssignments === 1 ? "" : "s"}.`,
      );
    }
    if (employeeReadiness.conflictingOccurrenceCount > 0) {
      employeeSeriesWarnings.push(
        `The selected employee is busy for ${employeeReadiness.conflictingOccurrenceCount} visit${employeeReadiness.conflictingOccurrenceCount === 1 ? "" : "s"}.`,
      );
    }
    if (employeeReadiness.unavailableOccurrenceCount > 0) {
      employeeSeriesWarnings.push(
        `The selected employee is unavailable for ${employeeReadiness.unavailableOccurrenceCount} visit${employeeReadiness.unavailableOccurrenceCount === 1 ? "" : "s"}.`,
      );
    }
    if (employeeReadiness.outsideDeclaredAvailabilityOccurrenceCount > 0) {
      employeeSeriesWarnings.push(
        `The selected employee is outside working hours for ${employeeReadiness.outsideDeclaredAvailabilityOccurrenceCount} visit${employeeReadiness.outsideDeclaredAvailabilityOccurrenceCount === 1 ? "" : "s"}.`,
      );
    }
  }
  const individualSeriesWarnings = preview.individualConflicts.individuals
    .filter((individual) => individual.conflictingOccurrenceCount > 0)
    .map((individual) =>
      `${individual.individualName} is already scheduled on ${individual.conflictingOccurrenceCount} visit${individual.conflictingOccurrenceCount === 1 ? "" : "s"}.`);
  const over = recurring
    ? (preview.seriesAuthorization?.individuals ?? []).some((individual) =>
      individual.periods.some((period) =>
        period.remainingAfterHours !== null && dec(period.remainingAfterHours).isNegative()))
    : preview.forecast.some((forecast) =>
      forecast.remainingAfterHours !== null && dec(forecast.remainingAfterHours).isNegative());
  const flagged = cats.budget.length > 0
    || cats.conflict.length > 0
    || cats.other.length > 0
    || seriesAuthorizationWarnings.length > 0
    || employeeSeriesWarnings.length > 0
    || individualSeriesWarnings.length > 0;
  const tone: "over" | "warn" | "ok" = over ? "over" : flagged ? "warn" : "ok";
  const color =
    tone === "over" ? "var(--color-pace-over)" : tone === "warn" ? "var(--color-pace-near)" : "var(--color-pace-on)";
  const heading = tone === "over" ? "Over authorization" : tone === "warn" ? "Review before saving" : "Clear to schedule";
  const sub =
    tone === "over"
      ? `${recurring ? "This series" : "This session"} exceeds the remaining authorized hours for at least one individual.`
      : tone === "warn"
        ? "You can still save with a reason, but check the flags below first."
        : recurring
          ? selectedEmployeeId
            ? "Every visit fits its authorization period, the individuals are free, and the selected employee is ready across the series."
            : "Every visit fits its authorization period and the individuals are free; the series will remain unassigned."
          : "Authorization valid, hours available, and no conflicts detected.";

  return (
    <div className="rounded-lg border p-3" role="status" style={{ borderColor: color, background: `color-mix(in srgb, ${color} 8%, transparent)` }}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold" style={{ color }}>{heading}</p>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      </div>
      <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{sub}</p>
      {recurring ? (
        <p className="mt-1 text-xs font-medium text-[var(--color-ink-soft)]">
          {occurrenceCount} visit{occurrenceCount === 1 ? "" : "s"}
          {totalPlannedHours ? ` · ${formatHours(totalPlannedHours)} h per individual` : ""}
        </p>
      ) : null}

      {!recurring && preview.forecast.length > 0 ? (
        <div className="mt-2 border-t border-[var(--color-rule)] pt-2">
          <p className="eyebrow">Remaining after this session</p>
          <div className="mt-1 space-y-0.5">
            {preview.forecast.map((f) => {
              const rem = f.remainingAfterHours;
              const neg = rem !== null && dec(rem).isNegative();
              return (
                <div key={f.individualId} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs text-[var(--color-ink-soft)]">{isGroup ? f.individualName : "Remaining hours"}</span>
                  <span className="tnum text-sm font-semibold" style={{ color: neg ? "var(--color-pace-over)" : undefined }}>
                    {f.authorizationAmbiguous
                      ? "review overlapping authorizations"
                      : rem === null ? "no authorization on file" : `${formatHours(rem)} h`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {cats.budget.length > 0 ? <WarnList color="var(--color-pace-over)" title="Authorization / budget" items={cats.budget} /> : null}
      {seriesAuthorizationWarnings.length > 0 ? <WarnList color="var(--color-pace-over)" title="Series authorization" items={seriesAuthorizationWarnings} /> : null}
      {cats.conflict.length > 0 ? <WarnList color="var(--color-pace-near)" title="Conflicts" items={cats.conflict} /> : null}
      {individualSeriesWarnings.length > 0 ? <WarnList color="var(--color-pace-near)" title="Individual conflicts" items={individualSeriesWarnings} /> : null}
      {employeeSeriesWarnings.length > 0 ? <WarnList color="var(--color-pace-near)" title="Employee readiness" items={employeeSeriesWarnings} /> : null}
      {cats.other.length > 0 ? <WarnList color="var(--color-pace-near)" title="Other flags" items={cats.other} /> : null}
    </div>
  );
}

function WarnList({ color, title, items }: { color: string; title: string; items: string[] }) {
  return (
    <div className="mt-2 border-t border-[var(--color-rule)] pt-2">
      <p className="eyebrow" style={{ color }}>{title}</p>
      <ul className="mt-0.5 space-y-0.5 text-xs text-[var(--color-ink-soft)]">
        {items.map((m, i) => <li key={i}>• {m}</li>)}
      </ul>
    </div>
  );
}

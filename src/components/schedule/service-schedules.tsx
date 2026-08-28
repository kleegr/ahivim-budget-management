"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CalendarDays, Pencil, Plus, Search, X } from "lucide-react";
import { EmptyState, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import type { PlanningSeriesIssue, PlanningSeriesRow } from "@/lib/data/planning-queries";
import { formatHours } from "@/lib/money";
import CreateSessionModal from "./create-session-modal";
import EditServiceScheduleModal from "./edit-service-schedule-modal";
import type { Picker, ProgramPicker } from "./shared";
import { seriesEditContext, seriesVersionContext } from "./version-context";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const ISSUE: Record<PlanningSeriesIssue, { label: string; tone: "danger" | "warn" | "info" }> = {
  unassigned: { label: "Employee needed", tone: "danger" },
  conflict: { label: "Time conflict", tone: "danger" },
  over_budget: { label: "Over budget", tone: "danger" },
  assignment_gap: { label: "Assignment gap", tone: "warn" },
  authorization_gap: { label: "Budget gap", tone: "warn" },
  no_future_occurrences: { label: "No future sessions", tone: "warn" },
  session_warning: { label: "Review", tone: "info" },
};

function dateLabel(value: string): string {
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`));
}

function timeLabel(value: string | null): string {
  if (!value) return "Time not set";
  const [hourText, minute = "00"] = value.split(":");
  const hour = Number(hourText);
  if (!Number.isFinite(hour)) return value;
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function recurrenceLabel(row: PlanningSeriesRow): string {
  const days = row.weekdays.map((day) => WEEKDAY[day]).filter(Boolean).join(", ");
  if (row.frequency === "daily") {
    return row.interval > 1 ? `Every ${row.interval} days` : "Every day";
  }
  const interval = row.interval > 1 ? `Every ${row.interval} weeks` : "Every week";
  return days ? `${days} / ${interval}` : interval;
}

function scheduleHref(row: PlanningSeriesRow): string {
  const params = new URLSearchParams({ view: "calendar" });
  if (row.nextOccurrenceDate) {
    params.set("date", row.nextOccurrenceDate);
    params.set("calendarView", "day");
  }
  if (row.participantIds.length === 1) params.set("individualId", row.participantIds[0]!);
  else if (row.employeeId) params.set("employeeId", row.employeeId);
  if (row.programId) params.set("programId", row.programId);
  return `/schedule?${params.toString()}`;
}

function EffectiveDates({ row }: { row: PlanningSeriesRow }) {
  const version = seriesVersionContext(row);
  return (
    <>
      <p className={`whitespace-nowrap text-xs ${version.startPrefix ? "font-semibold text-[var(--color-primary)]" : ""}`}>
        {version.startPrefix ? `${version.startPrefix} ` : ""}{dateLabel(row.startDate)}
      </p>
      <p className={`mt-0.5 whitespace-nowrap text-xs ${version.endPrefix === "Current through" ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"}`}>
        {version.endPrefix} {dateLabel(row.endDate)}
      </p>
    </>
  );
}

type ReadinessFilter = "" | "attention" | "ready" | "unassigned" | "over_budget" | "conflict";

export default function ServiceSchedules({
  rows,
  today,
  canManage,
  employees,
  individuals,
  programs,
  initialFilters,
}: {
  rows: PlanningSeriesRow[];
  today: string;
  canManage: boolean;
  employees: Picker[];
  individuals: Picker[];
  programs: ProgramPicker[];
  initialFilters?: {
    employeeId?: string;
    individualId?: string;
    programId?: string;
  };
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [employeeId, setEmployeeId] = useState(initialFilters?.employeeId ?? "");
  const [individualId, setIndividualId] = useState(initialFilters?.individualId ?? "");
  const [programId, setProgramId] = useState(initialFilters?.programId ?? "");
  const [readiness, setReadiness] = useState<ReadinessFilter>("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PlanningSeriesRow | null>(null);
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      if (employeeId && row.employeeId !== employeeId) return false;
      if (individualId && !row.participantIds.includes(individualId)) return false;
      if (programId && row.programId !== programId) return false;
      if (readiness === "attention" && row.issueCodes.length === 0) return false;
      if (readiness === "ready" && row.issueCodes.length > 0) return false;
      if (
        (readiness === "unassigned" || readiness === "over_budget" || readiness === "conflict")
        && !row.issueCodes.includes(readiness)
      ) return false;
      if (!query) return true;
      return [row.employeeName, row.programName, row.serviceType, ...row.participantNames]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(query));
    });
  }, [employeeId, individualId, programId, readiness, rows, search]);

  const hasFilters = Boolean(search || employeeId || individualId || programId || readiness);
  const clearFilters = () => {
    setSearch("");
    setEmployeeId("");
    setIndividualId("");
    setProgramId("");
    setReadiness("");
  };

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <CalendarDays aria-hidden className="h-4 w-4 text-[var(--color-primary)]" />
            <h2 className="display text-base font-semibold">Recurring service schedules</h2>
          </div>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            {filteredRows.length === rows.length ? `${rows.length} active schedules` : `${filteredRows.length} of ${rows.length} schedules`}
          </p>
        </div>
        {canManage ? (
          <button type="button" onClick={() => setCreating(true)} className="btn btn-sm btn-primary">
            <Plus aria-hidden className="h-4 w-4" /> New schedule
          </button>
        ) : null}
      </div>

      <div className="grid gap-2 border-y border-[var(--color-rule)] py-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(150px,auto))_auto]">
        <label className="relative block">
          <span className="sr-only">Search schedules</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search schedules"
            className="h-9 w-full rounded border border-[var(--color-rule-strong)] bg-white pl-9 pr-3 text-sm"
          />
        </label>
        <select aria-label="Employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="select">
          <option value="">All employees</option>
          {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}</option>)}
        </select>
        <select aria-label="Individual" value={individualId} onChange={(event) => setIndividualId(event.target.value)} className="select">
          <option value="">All individuals</option>
          {individuals.map((individual) => <option key={individual.id} value={individual.id}>{individual.label}</option>)}
        </select>
        <select aria-label="Program" value={programId} onChange={(event) => setProgramId(event.target.value)} className="select">
          <option value="">All programs</option>
          {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
        </select>
        <select aria-label="Readiness" value={readiness} onChange={(event) => setReadiness(event.target.value as ReadinessFilter)} className="select">
          <option value="">Any readiness</option>
          <option value="attention">Needs attention</option>
          <option value="ready">Ready</option>
          <option value="unassigned">Employee needed</option>
          <option value="over_budget">Over budget</option>
          <option value="conflict">Time conflict</option>
        </select>
        <button type="button" onClick={clearFilters} disabled={!hasFilters} className="btn btn-sm btn-ghost disabled:invisible">
          <X aria-hidden className="h-4 w-4" /> Clear
        </button>
      </div>

      {filteredRows.length === 0 ? (
        <EmptyState compact title={rows.length === 0 ? "No service schedules yet" : "No schedules match"} icon={<CalendarDays aria-hidden className="h-5 w-5" />}>
          {rows.length === 0 ? "Create a recurring schedule to begin planning authorized hours." : "Change or clear the active filters."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border-b border-[var(--color-rule)]">
          <Table
            caption="Active recurring service schedules"
            head={
              <>
                <Th>Individual</Th>
                <Th>Employee</Th>
                <Th>Program</Th>
                <Th>Weekly pattern</Th>
                <Th numeric>Per visit</Th>
                <Th>Effective dates</Th>
                <Th>Budget readiness</Th>
                <Th>Next</Th>
                <Th><span className="sr-only">Actions</span></Th>
              </>
            }
          >
            {filteredRows.map((row) => {
              const editContext = seriesEditContext(row.id, row.successorSeriesId);
              const editTarget = rowsById.get(editContext.targetSeriesId) ?? row;
              const editsUpcoming = editTarget.id !== row.id;
              return (
              <Tr key={row.id}>
                <Td>
                  <p className="max-w-60 font-semibold">
                    {row.participantNames.length > 0
                      ? row.participantNames.map((name, index) => (
                          <span key={row.participantIds[index] ?? `${name}-${index}`}>
                            {index > 0 ? ", " : null}
                            <Link href={`/schedule?view=calendar&individualId=${encodeURIComponent(row.participantIds[index] ?? "")}`} className="hover:text-[var(--color-primary)] hover:underline">{name}</Link>
                          </span>
                        ))
                      : "No individual"}
                  </p>
                  {row.participantNames.length > 1 ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Group of {row.participantNames.length}</p> : null}
                </Td>
                <Td>
                  {row.employeeId ? (
                    <Link href={`/schedule?view=calendar&employeeId=${encodeURIComponent(row.employeeId)}`} className="font-medium hover:text-[var(--color-primary)] hover:underline">
                      {row.employeeName ?? "Employee"}
                    </Link>
                  ) : <span className="font-semibold text-[var(--color-danger)]">Unassigned</span>}
                </Td>
                <Td>
                  <p className="font-medium">{row.programName}</p>
                  {row.serviceType ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{row.serviceType}</p> : null}
                </Td>
                <Td>
                  <p className="whitespace-nowrap font-medium">{recurrenceLabel(row)}</p>
                  <p className="mt-0.5 whitespace-nowrap text-xs text-[var(--color-ink-faint)]">
                    {timeLabel(row.startTime)}{row.endTime ? ` to ${timeLabel(row.endTime)}` : ""}
                  </p>
                </Td>
                <Td numeric><span className="tnum font-semibold">{formatHours(row.durationHours)} h</span></Td>
                <Td>
                  <EffectiveDates row={row} />
                </Td>
                <Td>
                  {row.issueCodes.length === 0 ? (
                    <StatusBadge label="Ready" tone="good" />
                  ) : (
                    <div className="flex max-w-64 flex-wrap gap-1.5">
                      {row.issueCodes.slice(0, 3).map((issue) => (
                        <StatusBadge key={issue} label={ISSUE[issue].label} tone={ISSUE[issue].tone} />
                      ))}
                    </div>
                  )}
                </Td>
                <Td>
                  <Link href={scheduleHref(row)} className="font-medium text-[var(--color-primary)] hover:underline">
                    {row.nextOccurrenceDate ? dateLabel(row.nextOccurrenceDate) : "Open calendar"}
                  </Link>
                  {row.futureOccurrenceCount > 0 ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{row.futureOccurrenceCount} sessions left</p> : null}
                </Td>
                <Td>
                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => setEditing(editTarget)}
                      aria-label={`${editContext.label} for ${row.participantNames.join(", ") || row.programName}`}
                      title={editsUpcoming ? `Edit upcoming version starting ${dateLabel(editTarget.startDate)}` : "Edit recurring schedule"}
                      className={`btn btn-sm btn-ghost ${editsUpcoming ? "whitespace-nowrap" : "btn-icon"}`}
                    >
                      <Pencil aria-hidden className="h-4 w-4" />
                      {editsUpcoming ? <span>{editContext.label}</span> : null}
                    </button>
                  ) : null}
                </Td>
              </Tr>
              );
            })}
          </Table>
        </div>
      )}

      {creating ? (
        <CreateSessionModal
          defaultDate={today}
          employees={employees}
          individuals={individuals}
          programs={programs}
          initialMode="recurring"
          initialEmployeeId={employeeId}
          initialIndividualId={individualId}
          initialProgramId={programId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      ) : null}

      {editing ? (
        <EditServiceScheduleModal
          row={editing}
          today={today}
          employees={employees}
          individuals={individuals}
          programs={programs}
          onClose={() => setEditing(null)}
          onUpdated={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

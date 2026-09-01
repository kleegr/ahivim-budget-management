"use client";

import { useMemo, useState } from "react";
import { CalendarX2, Pencil, Plus, Save, Search } from "lucide-react";
import { useRouter } from "next/navigation";

import { EmptyState, Hours, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import type { PlanningAssignmentRow } from "@/lib/data/planning-queries";
import { ModalShell, send, type Picker, type ProgramPicker } from "./shared";

type AssignmentDraft = {
  employeeId: string;
  individualId: string;
  programId: string;
  startDate: string;
  endDate: string;
  allowedHours: string;
  notes: string;
  reason: string;
};

const EMPTY: AssignmentDraft = {
  employeeId: "",
  individualId: "",
  programId: "",
  startDate: "",
  endDate: "",
  allowedHours: "",
  notes: "",
  reason: "",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function dateLabel(value: string | null): string {
  return value ? DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`)) : "Open";
}

function inputClass(): string {
  return "mt-1 h-10 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-soft)]";
}

export default function AssignmentManager({
  rows,
  employees,
  individuals,
  programs,
  canManage = true,
  showAllowedHours = true,
}: {
  rows: PlanningAssignmentRow[];
  employees: Picker[];
  individuals: Picker[];
  programs: ProgramPicker[];
  canManage?: boolean;
  showAllowedHours?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<PlanningAssignmentRow | "new" | null>(null);
  const [draft, setDraft] = useState<AssignmentDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      `${row.individualName} ${row.employeeName} ${row.programName ?? "all programs"}`
        .toLocaleLowerCase()
        .includes(needle));
  }, [query, rows]);

  const openNew = () => {
    setDraft(EMPTY);
    setError(null);
    setConfirmEnd(false);
    setEditing("new");
  };

  const openEdit = (row: PlanningAssignmentRow) => {
    setDraft({
      employeeId: row.employeeId,
      individualId: row.individualId,
      programId: row.programId ?? "",
      startDate: row.startDate ?? "",
      endDate: row.endDate ?? "",
      allowedHours: row.allowedHours ?? "",
      notes: row.notes ?? "",
      reason: "",
    });
    setError(null);
    setConfirmEnd(false);
    setEditing(row);
  };

  const close = () => {
    if (busy) return;
    setEditing(null);
    setConfirmEnd(false);
  };

  const save = async () => {
    if (!draft.employeeId || !draft.individualId) {
      setError("Choose both an employee and an individual.");
      return;
    }
    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
      setError("The end date must be on or after the start date.");
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      employeeId: draft.employeeId,
      individualId: draft.individualId,
      programId: draft.programId || null,
      startDate: draft.startDate || null,
      endDate: draft.endDate || null,
      ...(showAllowedHours ? { allowedHours: draft.allowedHours || null } : {}),
      notes: draft.notes || null,
      reason: draft.reason || null,
    };
    const result = editing === "new"
      ? await send("POST", "/api/assignments", body)
      : await send("PATCH", `/api/assignments/${editing!.id}`, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not save the assignment.");
      return;
    }
    setEditing(null);
    router.refresh();
  };

  const endAssignment = async () => {
    if (!editing || editing === "new") return;
    if (!draft.reason.trim()) {
      setError("Enter a reason before ending this assignment.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await send("PATCH", `/api/assignments/${editing.id}`, {
      action: "end",
      reason: draft.reason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not end the assignment.");
      return;
    }
    setEditing(null);
    router.refresh();
  };

  return (
    <section>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="relative block w-full sm:max-w-sm">
          <span className="text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Search assignments</span>
          <Search aria-hidden className="pointer-events-none absolute bottom-2.5 left-3 h-4 w-4 text-[var(--color-ink-faint)]" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={`${inputClass()} pl-9`}
            placeholder="Individual, employee, or program"
          />
        </label>
        {canManage ? (
          <button type="button" onClick={openNew} className="btn btn-sm btn-primary shrink-0">
            <Plus aria-hidden className="h-4 w-4" />
            New assignment
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState compact title="No assignments yet" icon={<Plus aria-hidden className="h-5 w-5" />}>
          Add the employee-to-individual relationships the calendar should plan against.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState compact title="No assignments match this search" icon={<Search aria-hidden className="h-5 w-5" />} />
      ) : (
        <div className="border-y border-[var(--color-rule)]">
          <Table
            caption="Current and future employee assignments"
            head={<><Th>Individual</Th><Th>Employee</Th><Th>Program</Th><Th>Effective dates</Th>{showAllowedHours ? <Th numeric>Allowed hours</Th> : null}<Th>Status</Th><Th><span className="sr-only">Actions</span></Th></>}
          >
            {filtered.map((row) => (
              <Tr key={row.id}>
                <Td><span className="font-semibold">{row.individualName}</span></Td>
                <Td>{row.employeeName}</Td>
                <Td>{row.programName ?? "All programs"}</Td>
                <Td><span className="whitespace-nowrap">{dateLabel(row.startDate)} to {dateLabel(row.endDate)}</span></Td>
                {showAllowedHours ? <Td numeric>{row.allowedHours === null ? <span className="text-[var(--color-ink-faint)]">-</span> : <Hours value={row.allowedHours} />}</Td> : null}
                <Td>
                  <StatusBadge
                    label={row.timing === "future" ? "Starts later" : row.timing === "ending_soon" ? "Ending soon" : "Effective now"}
                    tone={row.timing === "future" ? "info" : row.timing === "ending_soon" ? "warn" : "good"}
                  />
                </Td>
                <Td>{canManage ? (
                  <button type="button" onClick={() => openEdit(row)} className="btn btn-icon btn-sm" aria-label={`Edit assignment for ${row.individualName}`} title="Edit assignment">
                    <Pencil aria-hidden className="h-4 w-4" />
                  </button>
                ) : null}</Td>
              </Tr>
            ))}
          </Table>
        </div>
      )}

      {editing ? (
        <ModalShell title={editing === "new" ? "New assignment" : "Edit assignment"} onClose={close}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">
              Employee
              <select
                value={draft.employeeId}
                disabled={editing !== "new"}
                onChange={(event) => setDraft((current) => ({ ...current, employeeId: event.target.value }))}
                className={inputClass()}
              >
                <option value="">Choose employee...</option>
                {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">
              Individual
              <select
                value={draft.individualId}
                disabled={editing !== "new"}
                onChange={(event) => setDraft((current) => ({ ...current, individualId: event.target.value }))}
                className={inputClass()}
              >
                <option value="">Choose individual...</option>
                {individuals.map((individual) => <option key={individual.id} value={individual.id}>{individual.label}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium sm:col-span-2">
              Program
              <select
                value={draft.programId}
                disabled={editing !== "new"}
                onChange={(event) => setDraft((current) => ({ ...current, programId: event.target.value }))}
                className={inputClass()}
              >
                <option value="">All programs</option>
                {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">
              Starts
              <input type="date" value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} className={inputClass()} />
            </label>
            <label className="text-sm font-medium">
              Ends
              <input type="date" value={draft.endDate} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} className={inputClass()} />
            </label>
            {showAllowedHours ? (
              <label className="text-sm font-medium sm:col-span-2">
                Allowed hours
                <input type="number" min="0" step="0.25" value={draft.allowedHours} onChange={(event) => setDraft((current) => ({ ...current, allowedHours: event.target.value }))} className={inputClass()} />
              </label>
            ) : null}
            <label className="text-sm font-medium sm:col-span-2">
              Notes
              <textarea value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} className="mt-1 min-h-20 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" />
            </label>
            <label className="text-sm font-medium sm:col-span-2">
              Change reason
              <input value={draft.reason} onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} className={inputClass()} placeholder={editing === "new" ? "Optional" : "Optional for edits; required to end"} />
            </label>
          </div>

          {error ? <p role="alert" className="mt-4 rounded border border-[var(--color-pace-over)] bg-[#fff4f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">{error}</p> : null}

          <div className="mt-6 flex flex-col-reverse gap-2 border-t border-[var(--color-rule)] pt-4 sm:flex-row sm:justify-between">
            <div>
              {editing !== "new" ? (
                confirmEnd ? (
                  <button type="button" disabled={busy} onClick={endAssignment} className="btn btn-sm border-[var(--color-pace-over)] text-[var(--color-pace-over)]">
                    <CalendarX2 aria-hidden className="h-4 w-4" />
                    Confirm end
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => setConfirmEnd(true)} className="btn btn-sm">
                    <CalendarX2 aria-hidden className="h-4 w-4" />
                    End assignment
                  </button>
                )
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={close} className="btn btn-sm">Cancel</button>
              <button type="button" disabled={busy} onClick={save} className="btn btn-sm btn-primary">
                <Save aria-hidden className="h-4 w-4" />
                {busy ? "Saving..." : "Save assignment"}
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}
    </section>
  );
}

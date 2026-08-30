"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CorrectionRow } from "@/lib/manage/import-corrections";
import { Card, Badge, EmptyState } from "@/components/ui";

/** Uniform write helper — every request surfaces the server's own error text. */
async function send(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: unknown };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

const CORRECTABLE_FIELDS = [
  "payTo", "checkDate", "checkNumber", "hours", "rate", "amount", "totalNetPay",
  "periodBegin", "periodEnd", "programDescription", "individual", "employee",
  "calculatedInternalAmount", "paid",
] as const;

const fieldLabel = (field: string) => field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function hasContent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

const inputCls = "rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm";

export interface CorrectionQueueProps {
  canManage: boolean;
  batchId: string;
  rows: CorrectionRow[];
  total: number;
  programs: { id: string; code: string; name: string }[];
  individuals: { id: string; label: string }[];
  employees: { id: string; label: string }[];
}

function validationText(value: unknown): string {
  if (!Array.isArray(value)) return stringify(value);
  const messages = value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const issue = item as { field?: unknown; message?: unknown };
    if (typeof issue.message !== "string") return [];
    return [typeof issue.field === "string" && issue.field ? `${issue.field}: ${issue.message}` : issue.message];
  });
  return messages.join("; ") || "Review the source values on this row.";
}

export default function CorrectionQueue({
  canManage,
  batchId,
  rows,
  programs,
  individuals,
  employees,
}: CorrectionQueueProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null); // row id, or "bulk"
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgram, setBulkProgram] = useState("");
  const selectableRows = rows.filter((row) => row.applicationState !== "applied");

  function toggle(rowId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (
      prev.size === selectableRows.length
        ? new Set()
        : new Set(selectableRows.map((row) => row.id))
    ));
  }

  async function run(rowKey: string, url: string, body: Record<string, unknown>, method = "PATCH") {
    setBusy(rowKey);
    setError(null);
    setNotice(null);
    const res = await send(method, url, body);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "The change was not saved.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function resolve(rowId: string, field: "individualId" | "employeeId" | "programId", value: string | null) {
    await run(rowId, `/api/import-rows/${rowId}`, { action: "resolve", [field]: value });
  }

  async function correctField(rowId: string, field: string, value: string) {
    await run(rowId, `/api/import-rows/${rowId}`, { action: "correct", patch: { [field]: value } });
  }

  async function resetRow(rowId: string) {
    if (!window.confirm("Clear the field corrections on this row? Matching decisions are kept.")) return;
    await run(rowId, `/api/import-rows/${rowId}`, { action: "reset" });
  }

  async function applyRow(rowId: string, rememberProgramAlias: boolean) {
    if (!window.confirm("Apply this corrected source row to the ledger? This creates one transaction and one service allocation.")) return;
    const ok = await run(rowId, `/api/import-rows/${rowId}`, {
      action: "apply",
      rememberProgramAlias,
      reason: "Reviewed and applied from the import correction queue",
    });
    if (ok) setNotice("The corrected row was applied to the ledger and removed from attention.");
  }

  async function applyBulkProgram() {
    if (selected.size === 0 || !bulkProgram) return;
    const ok = await run("bulk", `/api/import-batches/${batchId}/bulk`, {
      action: "program",
      rowIds: [...selected],
      programId: bulkProgram,
    }, "POST");
    if (ok) {
      setNotice(`Resolved the program on ${selected.size} row(s).`);
      setSelected(new Set());
    }
  }

  if (rows.length === 0) {
    return <EmptyState title="No rows">Nothing matches this view. Every row in this batch is resolved.</EmptyState>;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">
          {notice}
        </p>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2 text-sm">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={selected.size === selectableRows.length && selectableRows.length > 0}
              onChange={toggleAll}
              aria-label="Select all rows"
            />
            <span className="text-[var(--color-ink-soft)]">
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
          </label>
          <span className="mx-1 h-4 w-px bg-[var(--color-rule)]" aria-hidden />
          <select
            value={bulkProgram}
            onChange={(e) => setBulkProgram(e.target.value)}
            aria-label="Bulk program"
            className={inputCls}
          >
            <option value="">Choose a program…</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>{p.code}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={applyBulkProgram}
            disabled={busy !== null || selected.size === 0 || !bulkProgram}
            className="rounded border border-[var(--color-rule-strong)] px-2 py-1 text-xs font-medium disabled:opacity-50"
          >
            Set program
          </button>
        </div>
      ) : null}

      {rows.map((row) => (
        <RowCard
          key={row.id}
          row={row}
          canManage={canManage}
          programs={programs}
          individuals={individuals}
          employees={employees}
          selected={selected.has(row.id)}
          disabled={busy !== null}
          onToggle={() => toggle(row.id)}
          onResolve={(field, value) => resolve(row.id, field, value)}
          onCorrect={(field, value) => correctField(row.id, field, value)}
          onReset={() => resetRow(row.id)}
          onApply={(rememberProgramAlias) => applyRow(row.id, rememberProgramAlias)}
        />
      ))}
    </div>
  );
}

function RowCard({
  row,
  canManage,
  programs,
  individuals,
  employees,
  selected,
  disabled,
  onToggle,
  onResolve,
  onCorrect,
  onReset,
  onApply,
}: {
  row: CorrectionRow;
  canManage: boolean;
  programs: { id: string; code: string; name: string }[];
  individuals: { id: string; label: string }[];
  employees: { id: string; label: string }[];
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onResolve: (field: "individualId" | "employeeId" | "programId", value: string | null) => void;
  onCorrect: (field: string, value: string) => void;
  onReset: () => void;
  onApply: (rememberProgramAlias: boolean) => void;
}) {
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [rememberProgramAlias, setRememberProgramAlias] = useState(true);

  const nestedRaw = row.raw?.raw;
  const displayedRaw = nestedRaw && typeof nestedRaw === "object" && !Array.isArray(nestedRaw)
    ? nestedRaw as Record<string, unknown>
    : row.raw;
  const rawEntries = Object.entries(displayedRaw ?? {});
  const correctedEntries = row.corrected ? Object.entries(row.corrected) : [];

  function submitCorrection(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = field.trim();
    if (!f) return;
    onCorrect(f, value);
    setField("");
    setValue("");
  }

  return (
    <div id={`row-${row.id}`} className="scroll-mt-24 target:rounded-lg target:ring-2 target:ring-[var(--color-primary)] target:ring-offset-2" tabIndex={-1}>
    <Card>
      <div className="flex flex-wrap items-start gap-3 border-b border-[var(--color-rule)] px-5 py-3">
        {canManage && row.applicationState !== "applied" ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select row ${row.sourceRowNumber}`}
            className="mt-1"
          />
        ) : null}
        <div className="min-w-0">
          <p className="display text-sm font-medium">
            Row {row.sourceRowNumber}
            <span className="ml-2 text-xs font-normal text-[var(--color-ink-faint)]">{row.sheetName}</span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge value={row.status} />
            {row.correctionStatus ? (
              <span className="text-xs text-[var(--color-ink-faint)]">corrected</span>
            ) : null}
          </div>
        </div>
        <div className="ml-auto text-xs text-[var(--color-ink-faint)]">Source history is preserved</div>
      </div>

      <div className="grid gap-4 px-5 py-4 lg:grid-cols-2">
        <div>
          <p className="eyebrow">Source values</p>
          {rawEntries.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--color-ink-faint)]">No stored source cells.</p>
          ) : (
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
              {rawEntries.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[var(--color-ink-faint)]">{k}</dt>
                  <dd className="break-words">{stringify(v) || <span className="text-[var(--color-ink-faint)]">—</span>}</dd>
                </div>
              ))}
            </dl>
          )}

          {correctedEntries.length > 0 ? (
            <div className="mt-3 rounded border border-[var(--color-pace-near)] bg-[#fff4ed] px-3 py-2">
              <p className="eyebrow text-[var(--color-pace-near)]">Corrections</p>
              <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                {correctedEntries.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-[var(--color-ink-faint)]">{k}</dt>
                    <dd className="break-words font-medium">{stringify(v) || <span className="text-[var(--color-ink-faint)]">—</span>}</dd>
                  </div>
                ))}
              </dl>
              {canManage && row.applicationState !== "applied" ? (
                <button
                  type="button"
                  onClick={onReset}
                  disabled={disabled}
                  className="mt-2 text-xs text-[var(--color-primary)] underline disabled:opacity-50"
                >
                  Reset corrections
                </button>
              ) : null}
            </div>
          ) : null}

          {hasContent(row.validationErrors) ? (
            <p className="mt-3 text-xs text-[var(--color-pace-over)]">
              Needs correction: {validationText(row.validationErrors)}
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <div>
            <p className="eyebrow">Resolved matches</p>
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-[var(--color-ink-faint)]">Individual</dt>
              <dd>{row.individualName ?? <span className="text-[var(--color-ink-faint)]">—</span>}</dd>
              <dt className="text-[var(--color-ink-faint)]">Employee</dt>
              <dd>{row.employeeName ?? <span className="text-[var(--color-ink-faint)]">—</span>}</dd>
              <dt className="text-[var(--color-ink-faint)]">Program</dt>
              <dd>{row.programName ?? <span className="text-[var(--color-ink-faint)]">—</span>}</dd>
            </dl>
          </div>

          {canManage && row.applicationState !== "applied" ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <span className="w-20 text-xs text-[var(--color-ink-faint)]">Program</span>
                <select
                  defaultValue={row.resolvedProgramId ?? ""}
                  onChange={(e) => onResolve("programId", e.target.value || null)}
                  disabled={disabled}
                  aria-label={`Resolve program for row ${row.sourceRowNumber}`}
                  className={`${inputCls} flex-1`}
                >
                  <option value="">— none —</option>
                  {programs.map((p) => (
                    <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span className="w-20 text-xs text-[var(--color-ink-faint)]">Individual</span>
                <select
                  defaultValue={row.resolvedIndividualId ?? ""}
                  onChange={(e) => onResolve("individualId", e.target.value || null)}
                  disabled={disabled}
                  aria-label={`Resolve individual for row ${row.sourceRowNumber}`}
                  className={`${inputCls} flex-1`}
                >
                  <option value="">— none —</option>
                  {individuals.map((i) => (
                    <option key={i.id} value={i.id}>{i.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span className="w-20 text-xs text-[var(--color-ink-faint)]">Employee</span>
                <select
                  defaultValue={row.resolvedEmployeeId ?? ""}
                  onChange={(e) => onResolve("employeeId", e.target.value || null)}
                  disabled={disabled}
                  aria-label={`Resolve employee for row ${row.sourceRowNumber}`}
                  className={`${inputCls} flex-1`}
                >
                  <option value="">— none —</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.label}</option>
                  ))}
                </select>
              </label>

              <form onSubmit={submitCorrection} className="flex flex-wrap items-center gap-2">
                <select
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  aria-label={`Correction field for row ${row.sourceRowNumber}`}
                  className={`${inputCls} w-32`}
                >
                  <option value="">Choose field</option>
                  {CORRECTABLE_FIELDS.map((sourceField) => (
                    <option key={sourceField} value={sourceField}>{fieldLabel(sourceField)}</option>
                  ))}
                </select>
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="New value"
                  aria-label={`Correction value for row ${row.sourceRowNumber}`}
                  className={`${inputCls} flex-1`}
                />
                <button
                  type="submit"
                  disabled={disabled || !field.trim()}
                  className="rounded border border-[var(--color-rule-strong)] px-2 py-1 text-xs font-medium disabled:opacity-50"
                >
                  Correct
                </button>
              </form>

              <div className={`rounded border px-3 py-2 text-sm ${
                row.applicationState === "ready"
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
                  : "border-[var(--color-rule)] bg-[var(--color-canvas)]"
              }`}>
                <p className="font-medium">
                  {row.applicationState === "ready" ? "Ready to apply" : "Cannot apply yet"}
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{row.applicationMessage}</p>
                {row.applicationState === "ready" ? (
                  <>
                    <label className="mt-2 flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={rememberProgramAlias}
                        onChange={(event) => setRememberProgramAlias(event.target.checked)}
                      />
                      <span>Remember this program spelling for future imports</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => onApply(rememberProgramAlias)}
                      disabled={disabled}
                      className="mt-2 rounded bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {disabled ? "Applying…" : "Apply corrected row"}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : row.applicationState === "applied" ? (
            <div className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm">
              <p className="font-medium">Applied to the ledger</p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{row.applicationMessage}</p>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
    </div>
  );
}

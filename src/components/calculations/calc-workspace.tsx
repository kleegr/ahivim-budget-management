"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { dec, formatMoney } from "@/lib/money";
import type { CalculationResult } from "@/lib/business/calculation";
import type { CalculationRow } from "@/lib/manage/calculations";
import {
  Card,
  Table,
  Th,
  Td,
  Tr,
  Money,
  Badge,
  EmptyState,
  StatTile,
} from "@/components/ui";

const inputCls =
  "mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5 text-sm";

/** Uniform write/read helper — every request surfaces the server's own error text. */
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
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      data?: unknown;
    };
    if (!res.ok || json.ok === false)
      return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

export interface ProgramOption {
  id: string;
  code: string;
  name: string;
  agencyRate: string | null;
  internalRate: string | null;
}

export interface CalcWorkspaceProps {
  canManage: boolean;
  individualId: string;
  individualName: string;
  programs: ProgramOption[];
  active: CalculationRow[];
  history: CalculationRow[];
}

interface FormState {
  programId: string;
  annualAuthorizedHours: string;
  annualAuthorizedDollars: string;
  programRate: string;
  individualRateOverride: string;
  agencyRate: string;
  months: string;
  basis: "annual" | "monthly";
  cut1Percent: string;
  cut2Percent: string;
  cutOrder: "sequential" | "parallel";
  clockAdjustment: string;
  netAdjustment: string;
  afterAllAdjustment: string;
  spreadsheetValue: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  programId: "",
  annualAuthorizedHours: "",
  annualAuthorizedDollars: "",
  programRate: "",
  individualRateOverride: "",
  agencyRate: "",
  months: "12",
  basis: "annual",
  cut1Percent: "",
  cut2Percent: "",
  cutOrder: "sequential",
  clockAdjustment: "",
  netAdjustment: "",
  afterAllAdjustment: "",
  spreadsheetValue: "",
  notes: "",
};

/** Only the pure-engine inputs — spreadsheet value and notes are not sent here. */
function toPreviewBody(f: FormState): Record<string, unknown> {
  return {
    annualAuthorizedHours: f.annualAuthorizedHours,
    annualAuthorizedDollars: f.annualAuthorizedDollars,
    programRate: f.programRate,
    individualRateOverride: f.individualRateOverride,
    agencyRate: f.agencyRate,
    months: f.months,
    basis: f.basis,
    cut1Percent: f.cut1Percent,
    cut2Percent: f.cut2Percent,
    cutOrder: f.cutOrder,
    clockAdjustment: f.clockAdjustment,
    netAdjustment: f.netAdjustment,
    afterAllAdjustment: f.afterAllAdjustment,
  };
}

/** The system's final figure for a saved row (After All, then net, then gross). */
function systemValue(row: CalculationRow): string {
  return row.afterAll ?? row.finalNet ?? row.finalGross ?? "0";
}

/** Explain, in words, why a system figure differs from the spreadsheet's. */
function explainDifference(
  spreadsheet: string,
  system: string,
  applied: { label: string; amount: string | null }[],
): string {
  const diff = dec(system).minus(dec(spreadsheet));
  if (diff.abs().lte("0.01")) return "Matches the spreadsheet figure.";
  const steps = applied
    .filter((a) => a.amount !== null && !dec(a.amount).isZero())
    .map((a) => `${a.label} ${formatMoney(a.amount)}`);
  const because = steps.length ? ` after ${steps.join(", ")}` : "";
  const direction = diff.isNegative() ? "below" : "above";
  return `System is ${formatMoney(diff.abs())} ${direction} the spreadsheet${because}.`;
}

interface LabeledInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  help?: string;
}

function LabeledInput({ label, value, onChange, type = "text", placeholder, help }: LabeledInputProps) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        placeholder={placeholder}
        step={type === "number" ? "any" : undefined}
        className={inputCls}
      />
      {help ? <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">{help}</span> : null}
    </label>
  );
}

interface LabeledSelectProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}

function LabeledSelect({ label, value, onChange, options }: LabeledSelectProps) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function CalcWorkspace({
  canManage,
  individualId,
  individualName,
  programs,
  active,
  history,
}: CalcWorkspaceProps) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [result, setResult] = useState<CalculationResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  function update(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
    setSaveNotice(null);
  }

  function onProgram(id: string) {
    const p = programs.find((x) => x.id === id);
    update({
      programId: id,
      programRate: p?.internalRate ?? "",
      agencyRate: p?.agencyRate ?? "",
    });
  }

  // Live, debounced preview. Every keystroke re-runs the engine so the workspace
  // always shows the full step-by-step breakdown, never just a final number.
  useEffect(() => {
    let ignore = false;
    const handle = setTimeout(async () => {
      const res = await send("POST", "/api/calculations/preview", toPreviewBody(form));
      if (ignore) return;
      if (!res.ok) {
        setPreviewError(res.error ?? "Those inputs could not be calculated.");
        return;
      }
      setPreviewError(null);
      setResult(res.data as CalculationResult);
    }, 350);
    return () => {
      ignore = true;
      clearTimeout(handle);
    };
  }, [form]);

  async function save() {
    if (!form.programRate.trim() && !form.annualAuthorizedDollars.trim()) {
      setSaveError("Enter a program rate (and hours) or an authorized dollar amount before saving.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    const res = await send("POST", "/api/calculations", {
      ...toPreviewBody(form),
      individualId,
      programId: form.programId || undefined,
      spreadsheetValue: form.spreadsheetValue || undefined,
      notes: form.notes || undefined,
      reason: reason.trim() || undefined,
    });
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error ?? "Could not save the calculation.");
      return;
    }
    setReason("");
    setSaveNotice("Saved. A new revision is now the active calculation.");
    router.refresh();
  }

  const saved = [...active, ...history];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- Inputs ---- */}
        <Card title="Inputs" description={`Planning figures for ${individualName}.`}>
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <LabeledSelect
                label="Program"
                value={form.programId}
                onChange={onProgram}
                options={[
                  { value: "", label: "No program (rates entered by hand)" },
                  ...programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
                ]}
              />
              <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">
                Choosing a program autofills its internal and agency rates below.
              </span>
            </div>
            <LabeledInput
              label="Annual authorized hours"
              value={form.annualAuthorizedHours}
              onChange={(v) => update({ annualAuthorizedHours: v })}
              type="number"
              placeholder="e.g. 1000"
            />
            <LabeledInput
              label="Or authorized dollars"
              value={form.annualAuthorizedDollars}
              onChange={(v) => update({ annualAuthorizedDollars: v })}
              type="number"
              placeholder="overrides hours × rate"
            />
            <LabeledInput
              label="Program rate"
              value={form.programRate}
              onChange={(v) => update({ programRate: v })}
              type="number"
            />
            <LabeledInput
              label="Individual rate override"
              value={form.individualRateOverride}
              onChange={(v) => update({ individualRateOverride: v })}
              type="number"
              placeholder="optional"
            />
            <LabeledInput
              label="Agency rate"
              value={form.agencyRate}
              onChange={(v) => update({ agencyRate: v })}
              type="number"
              placeholder="optional"
            />
            <LabeledInput
              label="Months"
              value={form.months}
              onChange={(v) => update({ months: v })}
              type="number"
            />
            <LabeledSelect
              label="Basis"
              value={form.basis}
              onChange={(v) => update({ basis: v === "monthly" ? "monthly" : "annual" })}
              options={[
                { value: "annual", label: "Annual" },
                { value: "monthly", label: "Monthly" },
              ]}
            />
            <LabeledInput
              label="First cut %"
              value={form.cut1Percent}
              onChange={(v) => update({ cut1Percent: v })}
              placeholder='e.g. 10 or 0.1 or 10%'
            />
            <LabeledInput
              label="Second cut %"
              value={form.cut2Percent}
              onChange={(v) => update({ cut2Percent: v })}
              placeholder="optional"
            />
            <LabeledSelect
              label="Cut order"
              value={form.cutOrder}
              onChange={(v) => update({ cutOrder: v === "parallel" ? "parallel" : "sequential" })}
              options={[
                { value: "sequential", label: "Sequential (cut 2 on post-cut-1)" },
                { value: "parallel", label: "Parallel (both on the base)" },
              ]}
            />
            <LabeledInput
              label="Clock adjustment"
              value={form.clockAdjustment}
              onChange={(v) => update({ clockAdjustment: v })}
              type="number"
              placeholder="signed, optional"
            />
            <LabeledInput
              label="Net adjustment"
              value={form.netAdjustment}
              onChange={(v) => update({ netAdjustment: v })}
              type="number"
              placeholder="signed, optional"
            />
            <LabeledInput
              label="After All adjustment"
              value={form.afterAllAdjustment}
              onChange={(v) => update({ afterAllAdjustment: v })}
              type="number"
              placeholder="signed, optional"
            />
            <LabeledInput
              label="Spreadsheet value"
              value={form.spreadsheetValue}
              onChange={(v) => update({ spreadsheetValue: v })}
              type="number"
              placeholder="for comparison"
            />
            <div className="sm:col-span-2">
              <LabeledInput
                label="Notes"
                value={form.notes}
                onChange={(v) => update({ notes: v })}
                placeholder="optional"
              />
            </div>
          </div>
        </Card>

        {/* ---- Live result ---- */}
        <Card
          title="Result"
          description="Every step of the calculation, in order — not just the final figure."
        >
          <div className="space-y-4 px-5 py-4">
            {previewError ? (
              <p
                role="alert"
                className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]"
              >
                {previewError}
              </p>
            ) : null}

            {result ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <StatTile label="Final gross" value={formatMoney(result.finalGross)} />
                  <StatTile label="Final net" value={formatMoney(result.finalNet)} tone="good" />
                  <StatTile label="After All" value={formatMoney(result.afterAll)} />
                </div>

                <div className="overflow-hidden rounded border border-[var(--color-rule)]">
                  <ol>
                    {result.steps.map((s, i) => (
                      <li
                        key={s.key}
                        className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2 text-sm ${
                          i > 0 ? "border-t border-[var(--color-rule)]" : ""
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="font-medium">
                            <span className="mr-1.5 text-[var(--color-ink-faint)]">{i + 1}.</span>
                            {s.label}
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{s.formula}</p>
                        </div>
                        <span className="tnum font-semibold whitespace-nowrap">{s.value}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div>
                  <p className="eyebrow mb-1">Agency vs employee split</p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatTile
                      label="Agency gross"
                      value={result.agencyGross ? formatMoney(result.agencyGross) : undefined}
                      unavailable={result.agencyGross ? undefined : "Needs hours and an agency rate."}
                    />
                    <StatTile label="Internal amount" value={formatMoney(result.internalAmount)} />
                    <StatTile
                      label="Agency additional"
                      value={result.agencyAdditional ? formatMoney(result.agencyAdditional) : undefined}
                      unavailable={result.agencyAdditional ? undefined : "No agency uplift."}
                    />
                  </div>
                </div>

                {form.spreadsheetValue.trim() ? (
                  <div className="rounded border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2 text-sm">
                    <p className="eyebrow mb-1">Spreadsheet vs system</p>
                    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                      <span>
                        Spreadsheet:{" "}
                        <span className="tnum font-medium">{formatMoney(form.spreadsheetValue)}</span>
                      </span>
                      <span>
                        System (After All):{" "}
                        <span className="tnum font-medium">{formatMoney(result.afterAll)}</span>
                      </span>
                      <span>
                        Difference:{" "}
                        <span className="tnum font-medium">
                          {formatMoney(dec(result.afterAll).minus(dec(form.spreadsheetValue)))}
                        </span>
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                      {explainDifference(form.spreadsheetValue, result.afterAll, [
                        { label: "first cut", amount: result.cut1Amount },
                        { label: "second cut", amount: result.cut2Amount },
                        { label: "clock adjustment", amount: result.clockAdjustment },
                      ])}
                    </p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="py-6 text-center text-sm text-[var(--color-ink-faint)]">
                Enter figures on the left to see the calculation.
              </p>
            )}

            {canManage ? (
              <div className="border-t border-[var(--color-rule)] pt-3">
                <label className="block">
                  <span className="eyebrow">Reason (optional, recorded in the audit log)</span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className={inputCls}
                    placeholder="Why this calculation"
                  />
                </label>
                {saveError ? (
                  <p role="alert" className="mt-2 text-sm text-[var(--color-pace-over)]">
                    {saveError}
                  </p>
                ) : null}
                {saveNotice ? (
                  <p role="status" className="mt-2 text-sm text-[var(--color-primary)]">
                    {saveNotice}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="mt-3 rounded bg-[var(--color-primary)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save calculation"}
                </button>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      {/* ---- Saved calculations ---- */}
      <Card
        title="Saved calculations"
        description="The active calculation and every superseded revision. Where a spreadsheet value was recorded, its difference from the system figure is shown."
      >
        {saved.length === 0 ? (
          <EmptyState title="No saved calculations yet">
            Build a calculation above and save it to start the history for this individual.
          </EmptyState>
        ) : (
          <Table
            caption="Saved calculations and spreadsheet comparison"
            head={
              <>
                <Th>Status</Th>
                <Th numeric>Rev</Th>
                <Th>Program</Th>
                <Th numeric>Months</Th>
                <Th>Basis</Th>
                <Th numeric>Final net</Th>
                <Th numeric>After All</Th>
                <Th numeric>Spreadsheet</Th>
                <Th numeric>Difference</Th>
              </>
            }
          >
            {saved.map((row) => {
              const hasSheet = row.spreadsheetValue !== null && row.spreadsheetValue !== "";
              const diff = hasSheet
                ? dec(systemValue(row)).minus(dec(row.spreadsheetValue as string))
                : null;
              return (
                <Tr key={row.id}>
                  <Td>
                    <Badge
                      value={row.status === "active" ? "valid" : "discarded"}
                      label={row.status === "active" ? "Active" : "Superseded"}
                    />
                  </Td>
                  <Td numeric className="tnum">
                    {row.revision}
                  </Td>
                  <Td>{row.programCode ?? <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                  <Td numeric className="tnum">
                    {row.months}
                  </Td>
                  <Td>{row.basis}</Td>
                  <Td numeric>
                    <Money value={row.finalNet} />
                  </Td>
                  <Td numeric>
                    <Money value={row.afterAll} />
                  </Td>
                  <Td numeric>
                    <Money value={row.spreadsheetValue} />
                  </Td>
                  <Td numeric>
                    {diff ? (
                      <div>
                        <Money value={diff.toFixed(4)} />
                        <p className="mt-0.5 text-left text-xs font-normal text-[var(--color-ink-faint)]">
                          {explainDifference(row.spreadsheetValue as string, systemValue(row), [
                            { label: "first cut", amount: row.cut1Amount },
                            { label: "second cut", amount: row.cut2Amount },
                            { label: "clock adjustment", amount: row.clockAdjustment },
                          ])}
                        </p>
                      </div>
                    ) : (
                      <span className="text-[var(--color-ink-faint)]">—</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}

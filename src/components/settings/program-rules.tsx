"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState } from "@/components/ui";
import type { ProgramRulesRow } from "@/lib/manage/program-rules";

/** Uniform write helper — surfaces the server's own error text. */
async function send(
  method: string,
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false)
      return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server. Your change was not saved." };
  }
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const fieldCls =
  "mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5 text-sm";

function RuleEditor({ program }: { program: ProgramRulesRow }) {
  const router = useRouter();
  const [form, setForm] = useState<ProgramRulesRow>(program);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof ProgramRulesRow>(key: K, value: ProgramRulesRow[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await send("PATCH", `/api/programs/${program.id}/rules`, {
      oneToOneRequired: form.oneToOneRequired,
      groupsAllowed: form.groupsAllowed,
      maxGroupSize: form.maxGroupSize,
      allowMultipleEmployees: form.allowMultipleEmployees,
      allowMultipleIndividuals: form.allowMultipleIndividuals,
      allowIndividualRateOverride: form.allowIndividualRateOverride,
      selfHireConverts: form.selfHireConverts,
      agencyAdditionalRate: form.agencyAdditionalRate,
      requiredAuthType: form.requiredAuthType,
      serviceCategory: form.serviceCategory,
      paymentRecipient: form.paymentRecipient,
      consumptionSource: form.consumptionSource,
      rateScope: form.rateScope,
      renewalPolicy: form.renewalPolicy,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">
          <code className="text-xs">{program.code}</code>
          <span className="ml-2 text-[var(--color-ink-soft)]">{program.name}</span>
        </h3>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Toggle
          label="One-to-one required"
          checked={form.oneToOneRequired}
          onChange={(v) => set("oneToOneRequired", v)}
        />
        <Toggle
          label="Groups allowed"
          checked={form.groupsAllowed}
          onChange={(v) => set("groupsAllowed", v)}
        />
        <Toggle
          label="Multiple employees"
          checked={form.allowMultipleEmployees}
          onChange={(v) => set("allowMultipleEmployees", v)}
        />
        <Toggle
          label="Multiple individuals"
          checked={form.allowMultipleIndividuals}
          onChange={(v) => set("allowMultipleIndividuals", v)}
        />
        <Toggle
          label="Individual funder / employee rate overrides"
          checked={form.allowIndividualRateOverride}
          onChange={(v) => set("allowIndividualRateOverride", v)}
        />
        <Toggle
          label="Self-hire converts"
          checked={form.selfHireConverts}
          onChange={(v) => set("selfHireConverts", v)}
        />

        <label className="block">
          <span className="eyebrow">Max group size</span>
          <input
            type="number"
            min={1}
            step={1}
            value={form.maxGroupSize ?? ""}
            onChange={(e) =>
              set("maxGroupSize", e.target.value === "" ? null : Number(e.target.value))
            }
            placeholder="blank = unlimited"
            className={fieldCls}
          />
        </label>
        <label className="block">
          <span className="eyebrow">Agency spread rate</span>
          <input
            type="number"
            step="any"
            value={form.agencyAdditionalRate ?? ""}
            onChange={(e) =>
              set("agencyAdditionalRate", e.target.value === "" ? null : e.target.value)
            }
            placeholder="blank = derive from rates"
            className={fieldCls}
          />
        </label>
        <label className="block">
          <span className="eyebrow">Required auth type</span>
          <select
            value={form.requiredAuthType}
            onChange={(e) => set("requiredAuthType", e.target.value)}
            className={fieldCls}
          >
            <option value="hours">Hours</option>
            <option value="dollars">Dollars</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Service category</span>
          <select
            value={form.serviceCategory}
            onChange={(e) => set("serviceCategory", e.target.value)}
            className={fieldCls}
          >
            {![
              "direct_service",
              "self_hire",
              "group_service",
              "classes",
              "other",
            ].includes(form.serviceCategory) ? (
              <option value={form.serviceCategory}>{form.serviceCategory}</option>
            ) : null}
            <option value="direct_service">Direct service</option>
            <option value="self_hire">Self-hire</option>
            <option value="group_service">Group service</option>
            <option value="classes">Classes</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Payment recipient</span>
          <select
            value={form.paymentRecipient}
            onChange={(e) => set("paymentRecipient", e.target.value)}
            className={fieldCls}
          >
            <option value="agency">Agency</option>
            <option value="employee">Employee</option>
            <option value="external">External provider</option>
            <option value="not_applicable">Not applicable</option>
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Budget consumption</span>
          <select
            value={form.consumptionSource}
            onChange={(e) => set("consumptionSource", e.target.value)}
            className={fieldCls}
          >
            <option value="payroll">Payroll transactions</option>
            <option value="invoice">Issued invoices</option>
            <option value="manual">Manual events</option>
            <option value="mixed">Payroll and events</option>
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Rate scope</span>
          <select
            value={form.rateScope}
            onChange={(e) => set("rateScope", e.target.value)}
            className={fieldCls}
          >
            <option value="per_individual">Per individual</option>
            <option value="per_group">Per group</option>
            <option value="flat">Flat amount</option>
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Renewal policy</span>
          <select
            value={form.renewalPolicy}
            onChange={(e) => set("renewalPolicy", e.target.value)}
            className={fieldCls}
          >
            <option value="individual">Individual-specific dates</option>
            <option value="calendar">Calendar year</option>
            <option value="rolling">Rolling 12 months</option>
            <option value="custom">Custom period</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save rules"}
        </button>
        {error ? <span className="text-xs text-[var(--color-pace-over)]">{error}</span> : null}
        {saved ? <span className="text-xs text-[var(--color-primary)]">Saved.</span> : null}
      </div>
    </div>
  );
}

export default function ProgramRules({ programs }: { programs: ProgramRulesRow[] }) {
  return (
    <Card
      title="Program rules"
      description="How each program behaves: one-to-one vs group, the agency-vs-employee split, rate overrides, and what an authorization must specify. Every change is audited."
    >
      {programs.length === 0 ? (
        <EmptyState title="No programs are configured" />
      ) : (
        <div className="divide-y divide-[var(--color-rule)]">
          {programs.map((p) => (
            <RuleEditor key={p.id} program={p} />
          ))}
        </div>
      )}
    </Card>
  );
}

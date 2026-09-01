"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Card, EmptyState } from "@/components/ui";
import { Modal } from "@/components/manage/client";
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
  "select mt-1 w-full";
const inputCls = "input mt-1 w-full";

const serviceTypes = [
  { value: "direct_service", label: "Individual service" },
  { value: "group_service", label: "Group service" },
  { value: "self_hire", label: "Self-hire service" },
  { value: "classes", label: "Classes or monthly invoice" },
  { value: "other", label: "Other program" },
];

export function GuidedProgramButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceCategory, setServiceCategory] = useState("direct_service");
  const [requiredAuthType, setRequiredAuthType] = useState("hours");
  const [paymentRecipient, setPaymentRecipient] = useState("agency");
  const [consumptionSource, setConsumptionSource] = useState("payroll");
  const [rateScope, setRateScope] = useState("per_individual");

  function chooseService(value: string) {
    setServiceCategory(value);
    if (value === "classes") {
      setRequiredAuthType("dollars");
      setPaymentRecipient("agency");
      setConsumptionSource("invoice");
      setRateScope("flat");
    } else if (value === "group_service") {
      setRequiredAuthType("hours");
      setConsumptionSource("payroll");
      setRateScope("per_group");
    } else if (value === "self_hire") {
      setRequiredAuthType("hours");
      setPaymentRecipient("employee");
      setConsumptionSource("payroll");
      setRateScope("per_individual");
    } else {
      setRateScope("per_individual");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const groupsAllowed = serviceCategory === "group_service";
    setBusy(true);
    setError(null);
    const result = await send("POST", "/api/programs", {
      guidedSetup: true,
      name: raw.name,
      code: raw.code,
      notes: raw.notes,
      serviceCategory,
      requiredAuthType,
      paymentRecipient,
      consumptionSource,
      rateScope,
      renewalPolicy: raw.renewalPolicy,
      isGroupCapable: groupsAllowed,
      groupsAllowed,
      oneToOneRequired: !groupsAllowed,
      allowMultipleIndividuals: groupsAllowed,
      allowMultipleEmployees: raw.allowMultipleEmployees === "on",
      allowIndividualRateOverride: raw.allowIndividualRateOverride === "on",
      selfHireConverts: raw.selfHireConverts === "on",
      maxGroupSize: raw.maxGroupSize ? Number(raw.maxGroupSize) : null,
      agencyAdditionalRate: raw.agencyAdditionalRate || null,
      effectiveFrom: raw.effectiveFrom || null,
      agencyRate: raw.agencyRate || null,
      internalRate: raw.internalRate || null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "The program could not be saved.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden /> New program
      </button>
      {open ? (
        <Modal title="New program" onClose={() => (busy ? undefined : setOpen(false))}>
          <form onSubmit={submit} className="space-y-4">
            {error ? (
              <p role="alert" className="rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-danger)]">
                {error}
              </p>
            ) : null}

            <label className="block">
              <span className="text-sm font-medium">Program name</span>
              <input name="name" required data-modal-initial className="input mt-1 w-full" placeholder="For example, Community Habilitation" />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium">Type of service</span>
                <select value={serviceCategory} onChange={(event) => chooseService(event.target.value)} className={fieldCls}>
                  {serviceTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium">Budget is measured in</span>
                <select value={requiredAuthType} onChange={(event) => setRequiredAuthType(event.target.value)} className={fieldCls}>
                  <option value="hours">Hours</option>
                  <option value="dollars">Dollars</option>
                  <option value="both">Hours and dollars</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium">Payment goes to</span>
                <select value={paymentRecipient} onChange={(event) => setPaymentRecipient(event.target.value)} className={fieldCls}>
                  <option value="agency">The agency</option>
                  <option value="employee">The employee directly</option>
                  <option value="external">An outside provider</option>
                  <option value="not_applicable">No payment tracking</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium">Usage comes from</span>
                <select value={consumptionSource} onChange={(event) => setConsumptionSource(event.target.value)} className={fieldCls}>
                  <option value="payroll">Google Sheet transactions</option>
                  <option value="invoice">Issued invoices</option>
                  <option value="manual">Manual entries</option>
                  <option value="mixed">Transactions and manual entries</option>
                </select>
              </label>
            </div>

            <div className="border-t border-[var(--color-rule)] pt-4">
              <h3 className="text-sm font-semibold">Starting rates <span className="font-normal text-[var(--color-ink-soft)]">(optional)</span></h3>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">Leave these blank when the program does not have a standard rate.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-sm font-medium">Funder rate</span>
                  <input name="agencyRate" type="number" min="0" step="any" className="input mt-1 w-full" />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Employee base rate</span>
                  <input name="internalRate" type="number" min="0" step="any" className="input mt-1 w-full" />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Begins</span>
                  <input name="effectiveFrom" type="date" className="input mt-1 w-full" />
                </label>
              </div>
            </div>

            <details className="rounded border border-[var(--color-rule)] px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium">Short code</span>
                  <input name="code" className="input mt-1 w-full" placeholder="Created from the name if blank" />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Rate applies</span>
                  <select value={rateScope} onChange={(event) => setRateScope(event.target.value)} className={fieldCls}>
                    <option value="per_individual">Per individual</option>
                    <option value="per_group">Per group</option>
                    <option value="flat">As a flat amount</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Renewal</span>
                  <select name="renewalPolicy" defaultValue="individual" className={fieldCls}>
                    <option value="individual">Individual-specific date</option>
                    <option value="calendar">Calendar year</option>
                    <option value="rolling">Rolling 12 months</option>
                    <option value="custom">Custom period</option>
                  </select>
                </label>
                {serviceCategory === "group_service" ? (
                  <label className="block">
                    <span className="text-sm font-medium">Maximum group size</span>
                    <input name="maxGroupSize" type="number" min="1" step="1" className="input mt-1 w-full" placeholder="No limit" />
                  </label>
                ) : null}
                <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                  <input name="allowIndividualRateOverride" type="checkbox" defaultChecked /> Individual rates may differ
                </label>
                <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                  <input name="allowMultipleEmployees" type="checkbox" /> More than one employee may work
                </label>
                {serviceCategory === "self_hire" ? (
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                    <input name="selfHireConverts" type="checkbox" /> Convert self-hire rates
                  </label>
                ) : null}
                <label className="block sm:col-span-2">
                  <span className="text-sm font-medium">Agency spread rate</span>
                  <input name="agencyAdditionalRate" type="number" min="0" step="any" className="input mt-1 w-full" placeholder="Calculated from the two rates when blank" />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-sm font-medium">Notes</span>
                  <textarea name="notes" rows={2} className="input mt-1 w-full py-2" />
                </label>
              </div>
            </details>

            <div className="flex justify-end gap-2 border-t border-[var(--color-rule)] pt-4">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
                {busy ? "Creating..." : "Create program"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

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
    <details className="group">
      <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-5 py-3 marker:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[var(--color-ink)]">{program.name}</span>
          <span className="mt-0.5 block text-xs text-[var(--color-ink-soft)]">
            {program.code} / {form.requiredAuthType === "both" ? "hours and dollars" : form.requiredAuthType} / {form.paymentRecipient.replace("_", " ")}
          </span>
        </span>
        <span className="text-xs font-medium text-[var(--color-primary)] group-open:hidden">Edit setup</span>
        <span className="hidden text-xs font-medium text-[var(--color-primary)] group-open:inline">Close</span>
      </summary>

      <div className="border-t border-[var(--color-rule)] px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Budget is measured in</span>
            <select value={form.requiredAuthType} onChange={(e) => set("requiredAuthType", e.target.value)} className={fieldCls}>
              <option value="hours">Hours</option>
              <option value="dollars">Dollars</option>
              <option value="both">Hours and dollars</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Type of service</span>
            <select value={form.serviceCategory} onChange={(e) => set("serviceCategory", e.target.value)} className={fieldCls}>
              {!serviceTypes.some((option) => option.value === form.serviceCategory) ? <option value={form.serviceCategory}>{form.serviceCategory}</option> : null}
              {serviceTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Payment goes to</span>
            <select value={form.paymentRecipient} onChange={(e) => set("paymentRecipient", e.target.value)} className={fieldCls}>
              <option value="agency">The agency</option>
              <option value="employee">The employee directly</option>
              <option value="external">An outside provider</option>
              <option value="not_applicable">No payment tracking</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Usage comes from</span>
            <select value={form.consumptionSource} onChange={(e) => set("consumptionSource", e.target.value)} className={fieldCls}>
              <option value="payroll">Google Sheet transactions</option>
              <option value="invoice">Issued invoices</option>
              <option value="manual">Manual entries</option>
              <option value="mixed">Transactions and manual entries</option>
            </select>
          </label>
        </div>

        <details className="mt-4 rounded border border-[var(--color-rule)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Advanced rules</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Toggle label="One-to-one required" checked={form.oneToOneRequired} onChange={(v) => set("oneToOneRequired", v)} />
            <Toggle label="Groups allowed" checked={form.groupsAllowed} onChange={(v) => set("groupsAllowed", v)} />
            <Toggle label="Multiple employees" checked={form.allowMultipleEmployees} onChange={(v) => set("allowMultipleEmployees", v)} />
            <Toggle label="Multiple individuals" checked={form.allowMultipleIndividuals} onChange={(v) => set("allowMultipleIndividuals", v)} />
            <Toggle label="Individual rates may differ" checked={form.allowIndividualRateOverride} onChange={(v) => set("allowIndividualRateOverride", v)} />
            <Toggle label="Convert self-hire rates" checked={form.selfHireConverts} onChange={(v) => set("selfHireConverts", v)} />
            <label className="block">
              <span className="text-sm font-medium">Maximum group size</span>
              <input type="number" min={1} step={1} value={form.maxGroupSize ?? ""} onChange={(e) => set("maxGroupSize", e.target.value === "" ? null : Number(e.target.value))} placeholder="No limit" className={inputCls} />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Agency spread rate</span>
              <input type="number" min="0" step="any" value={form.agencyAdditionalRate ?? ""} onChange={(e) => set("agencyAdditionalRate", e.target.value === "" ? null : e.target.value)} placeholder="Calculated from rates" className={inputCls} />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Rate applies</span>
              <select value={form.rateScope} onChange={(e) => set("rateScope", e.target.value)} className={fieldCls}>
                <option value="per_individual">Per individual</option>
                <option value="per_group">Per group</option>
                <option value="flat">As a flat amount</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Renewal</span>
              <select value={form.renewalPolicy} onChange={(e) => set("renewalPolicy", e.target.value)} className={fieldCls}>
                <option value="individual">Individual-specific date</option>
                <option value="calendar">Calendar year</option>
                <option value="rolling">Rolling 12 months</option>
                <option value="custom">Custom period</option>
              </select>
            </label>
          </div>
        </details>

        <div className="mt-4 flex min-h-11 flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={busy} aria-busy={busy} className="btn btn-primary">
            {busy ? "Saving..." : "Save program setup"}
          </button>
          {error ? <span role="alert" className="text-sm text-[var(--color-danger)]">{error}</span> : null}
          {saved ? <span className="text-sm text-[var(--color-success)]">Saved.</span> : null}
        </div>
      </div>
    </details>
  );
}

export default function ProgramRules({ programs }: { programs: ProgramRulesRow[] }) {
  return (
    <Card
      title="Program setup"
      description="Open a program only when you need to change it. The four everyday choices appear first; rare rules stay under Advanced. Every change is audited."
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

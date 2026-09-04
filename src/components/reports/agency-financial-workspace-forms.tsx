"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  AutomaticSourceLink,
  SOURCE_LABEL,
  request,
} from "@/components/reports/agency-financial-shared";
import { Notice } from "@/components/ui";
import type {
  AgencyFinancialOptions,
  AutomaticIncomeSourceMatch,
} from "@/lib/data/agency-financial-report";
import type {
  ManualIncomeEntry,
  ManualIncomeSource,
} from "@/lib/manage/agency-financials";
import { agencyDate } from "@/lib/business/agency-time";
import { formatMoney } from "@/lib/money";

export type CountSeparatelyTarget = {
  id: string;
  label: string;
  source: AutomaticIncomeSourceMatch;
  action: "count_separately" | "treat_as_same_payment";
  splitAlreadyCounted: boolean;
};


function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">{label}{children}</label>;
}


function FormFooter({ saving, onClose }: { saving: boolean; onClose: () => void }) {
  return (
    <div className="flex justify-end gap-2 border-t border-[var(--color-rule)] pt-4">
      <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
    </div>
  );
}

export function IncomeForm({
  month,
  options,
  onClose,
  onSaved,
  onOpenProgramSplit,
}: {
  month: string;
  options: AgencyFinancialOptions;
  onClose: () => void;
  onSaved: () => void;
  onOpenProgramSplit: (selection: { individualId: string; programId: string; effectiveFrom: string }) => void;
}) {
  const [sourceType, setSourceType] = useState<ManualIncomeSource>("other");
  const [serviceDate, setServiceDate] = useState(`${month}-01`);
  const [individualId, setIndividualId] = useState("");
  const [programId, setProgramId] = useState("");
  const [grossAmount, setGrossAmount] = useState("");
  const [agencySharePercent, setAgencySharePercent] = useState("100");
  const [sourceRef, setSourceRef] = useState("");
  const [notes, setNotes] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [separatePaymentReason, setSeparatePaymentReason] = useState("");
  const [showSeparatePaymentReason, setShowSeparatePaymentReason] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = sourceType === "custom_program";
  const classReceipt = sourceType === "class";
  const dimensionsRequired = custom || (classReceipt && !sourceRef.trim());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await request("/api/agency-financials/income", {
      serviceDate,
      sourceType,
      individualId: individualId || null,
      programId: programId || null,
      grossAmount,
      agencySharePercent: custom ? undefined : agencySharePercent,
      sourceRef: sourceRef || null,
      notes: notes || null,
      overBudgetOverrideReason: overrideReason || null,
      automaticSourceOverrideReason: separatePaymentReason || null,
    });
    setSaving(false);
    if (!result.ok) {
      const message = result.error ?? "The income could not be recorded.";
      setShowSeparatePaymentReason(message.includes("separate-payment reason"));
      setError(message);
      return;
    }
    onSaved();
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Income type">
          <select className="select mt-1 w-full" value={sourceType} onChange={(event) => setSourceType(event.target.value as ManualIncomeSource)}>
            {Object.entries(SOURCE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Date">
          <input required className="input mt-1 w-full" type="date" value={serviceDate} onChange={(event) => setServiceDate(event.target.value)} />
        </Field>
      </div>
      <Field label="Gross income">
        <input required className="input tnum mt-1 w-full" inputMode="decimal" placeholder="0.00" value={grossAmount} onChange={(event) => setGrossAmount(event.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={custom ? "Individual (required)" : classReceipt ? "Individual (required without invoice number)" : "Individual (optional)"}>
          <select required={dimensionsRequired} className="select mt-1 w-full" value={individualId} onChange={(event) => setIndividualId(event.target.value)}>
            <option value="">None</option>
            {options.individuals.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </Field>
        <Field label={custom ? "Program (required)" : classReceipt ? "Program (required without invoice number)" : "Program (optional)"}>
          <select required={dimensionsRequired} className="select mt-1 w-full" value={programId} onChange={(event) => setProgramId(event.target.value)}>
            <option value="">None</option>
            {options.programs.map((item) => <option key={item.id} value={item.id}>{item.label}{item.code ? ` (${item.code})` : ""}</option>)}
          </select>
        </Field>
      </div>
      {!custom ? <Field label="Agency share (%)"><input className="input tnum mt-1 w-full" inputMode="decimal" value={agencySharePercent} onChange={(event) => setAgencySharePercent(event.target.value)} /></Field> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={sourceType === "class" ? "Invoice or payment reference (optional)" : "Reference (optional)"}>
          <input className="input mt-1 w-full" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} />
        </Field>
        <Field label="Budget override reason (only if needed)">
          <input className="input mt-1 w-full" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} />
        </Field>
      </div>
      {showSeparatePaymentReason ? (
        <Field label="Why is this a separate payment?">
          <input
            required
            minLength={5}
            className="input mt-1 w-full"
            value={separatePaymentReason}
            onChange={(event) => setSeparatePaymentReason(event.target.value)}
            placeholder="Example: Separate reimbursement received the same day"
          />
        </Field>
      ) : null}
      <Field label="Notes (optional)">
        <textarea className="input mt-1 min-h-20 w-full py-2" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>
      {sourceType === "class" ? (
        <Notice tone="info" title="Invoices are not cash receipts">Record the payment when it is actually received. You can use the invoice number as the reference; this will not consume the class allowance a second time.</Notice>
      ) : null}
      {custom ? (
        <Notice
          tone="info"
          title="The saved program split is authoritative"
          action={individualId && programId ? <button type="button" className="btn btn-sm btn-secondary" onClick={() => onOpenProgramSplit({ individualId, programId, effectiveFrom: serviceDate })}>Open program split</button> : undefined}
        >
          Choose the individual and program above. This also requires an active dollar budget for that program.
          {individualId ? <> <Link className="font-semibold text-[var(--color-primary)] hover:underline" href={`/individuals/${individualId}?view=budget`}>Open the budget</Link>.</> : null}
        </Notice>
      ) : null}
      {error ? <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">{error}</p> : null}
      <FormFooter saving={saving} onClose={onClose} />
    </form>
  );
}

export function ProgramSplitForm({
  options,
  initial,
  onClose,
  onSaved,
}: {
  options: AgencyFinancialOptions;
  initial?: { individualId: string; programId: string; effectiveFrom?: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [individualId, setIndividualId] = useState(initial?.individualId ?? options.individuals[0]?.id ?? "");
  const [programId, setProgramId] = useState(initial?.programId ?? options.programs[0]?.id ?? "");
  const [share, setShare] = useState("100");
  const [effectiveFrom, setEffectiveFrom] = useState(initial?.effectiveFrom ?? agencyDate());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await request("/api/agency-financials/program-splits", {
      individualId,
      programId,
      agencySharePercent: share,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
      reason,
      notes: notes || null,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "The split could not be saved.");
      return;
    }
    onSaved();
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Individual"><select required className="select mt-1 w-full" value={individualId} onChange={(event) => setIndividualId(event.target.value)}>{options.individuals.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
        <Field label="Program"><select required className="select mt-1 w-full" value={programId} onChange={(event) => setProgramId(event.target.value)}>{options.programs.map((item) => <option key={item.id} value={item.id}>{item.label}{item.code ? ` (${item.code})` : ""}</option>)}</select></Field>
      </div>
      <Field label="Agency share (%)"><input required className="input tnum mt-1 w-full" inputMode="decimal" value={share} onChange={(event) => setShare(event.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts"><input required className="input mt-1 w-full" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></Field>
        <Field label="Ends (optional)"><input className="input mt-1 w-full" type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></Field>
      </div>
      <Field label="Reason"><input required minLength={5} className="input mt-1 w-full" value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      <Field label="Notes (optional)"><textarea className="input mt-1 min-h-20 w-full py-2" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
      {error ? <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">{error}</p> : null}
      <FormFooter saving={saving} onClose={onClose} />
    </form>
  );
}

export function EmployeeTermForm({
  options,
  initial,
  onClose,
  onSaved,
}: {
  options: AgencyFinancialOptions;
  initial?: { employeeId: string; individualId: string; effectiveFrom?: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(initial?.employeeId ?? options.employees[0]?.id ?? "");
  const [individualId, setIndividualId] = useState(initial?.individualId ?? options.individuals[0]?.id ?? "");
  const [share, setShare] = useState("100");
  const [effectiveFrom, setEffectiveFrom] = useState(initial?.effectiveFrom ?? agencyDate());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await request("/api/agency-financials/employee-terms", {
      employeeId,
      individualId,
      employeeSharePercent: share,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
      reason,
      notes: notes || null,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "The employee pay rule could not be saved.");
      return;
    }
    onSaved();
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee"><select required className="select mt-1 w-full" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{options.employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
        <Field label="Individual"><select required className="select mt-1 w-full" value={individualId} onChange={(event) => setIndividualId(event.target.value)}>{options.individuals.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
      </div>
      <Field label="Employee share of base (%)"><input required className="input tnum mt-1 w-full" inputMode="decimal" value={share} onChange={(event) => setShare(event.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts"><input required className="input mt-1 w-full" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></Field>
        <Field label="Ends (optional)"><input className="input mt-1 w-full" type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></Field>
      </div>
      <Field label="Reason"><input required minLength={5} className="input mt-1 w-full" value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      <Field label="Notes (optional)"><textarea className="input mt-1 min-h-20 w-full py-2" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
      {error ? <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">{error}</p> : null}
      <FormFooter saving={saving} onClose={onClose} />
    </form>
  );
}

export function VoidIncomeForm({ entry, onClose, onSaved }: { entry: ManualIncomeEntry; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await request(`/api/agency-financials/income/${entry.id}/void`, { reason });
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "The income could not be voided.");
      return;
    }
    onSaved();
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm text-[var(--color-ink-soft)]">Void {formatMoney(entry.grossAmount)} recorded on {entry.serviceDate}.{entry.programBudgetEventId ? " The linked program-budget use will be reversed too." : " Invoice and budget history will not change."}</p>
      <Field label="Reason"><input required minLength={5} className="input mt-1 w-full" value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      {error ? <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">{error}</p> : null}
      <FormFooter saving={saving} onClose={onClose} />
    </form>
  );
}

export function CountSeparatelyForm({
  target,
  month,
  onClose,
  onSaved,
}: {
  target: CountSeparatelyTarget;
  month: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await request(`/api/agency-financials/income/${target.id}/count-separately`, {
      action: target.action,
      sourceType: target.source.sourceType,
      sourceId: target.source.sourceId,
      reason,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "The income decision could not be saved.");
      return;
    }
    onSaved();
  };
  const isReversal = target.action === "treat_as_same_payment";
  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm leading-6 text-[var(--color-ink-soft)]">
        {target.label} currently matches <AutomaticSourceLink source={target.source} month={month} />.
        {isReversal
          ? " Confirm that both records describe the same payment. The matching source will own the income again, and its split rule will apply."
          : target.splitAlreadyCounted
            ? " Confirm only when these are genuinely separate payments. This income will then count too; its individual split is already included."
            : " Confirm only when these are genuinely separate payments. Both this income and its individual split will then count."}
      </p>
      <Field label={isReversal ? "Why are these the same payment?" : "Why is this a separate payment?"}>
        <textarea
          required
          minLength={5}
          className="input mt-1 min-h-24 w-full py-2"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={isReversal
            ? "Example: Both records refer to the same deposit"
            : "Example: Separate payment for a different service"}
        />
      </Field>
      {error ? <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-[var(--color-rule)] pt-4">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : isReversal ? "Treat as same payment" : "Count separately"}</button>
      </div>
    </form>
  );
}

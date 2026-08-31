"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  HandCoins,
  Plus,
  ReceiptText,
  Settings2,
  Split,
  Trash2,
  Users,
} from "lucide-react";
import { ModalShell } from "@/components/schedule/shared";
import { Money, Notice, Td, Th, Tr } from "@/components/ui";
import type {
  AgencyFinancialOptions,
  AgencyFinancialReport,
} from "@/lib/data/agency-financial-report";
import type {
  EmployeeIndividualCompensationTerm,
  ManualIncomeEntry,
  ManualIncomeSource,
  ProgramRevenueTerm,
} from "@/lib/manage/agency-financials";
import { agencyDate } from "@/lib/business/agency-time";
import { dec, formatMoney, formatPercent } from "@/lib/money";

type View = "summary" | "transactions" | "checks" | "set-asides" | "other-income" | "rules";
type Modal = "income" | "program-split" | "employee-term" | null;

const SOURCE_LABEL: Record<ManualIncomeSource, string> = {
  class: "Class income outside invoicing",
  reimbursement: "Reimbursement",
  custom_program: "Custom program",
  other: "Other income",
};

const VIEWS: { id: View; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "transactions", label: "Transactions" },
  { id: "checks", label: "Checks" },
  { id: "set-asides", label: "Set-asides" },
  { id: "other-income", label: "Other income" },
  { id: "rules", label: "Rules" },
];

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`));
}

function shiftMonth(month: string, amount: number): string {
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, part! - 1 + amount, 1)).toISOString().slice(0, 7);
}

function percent(value: string | null): string {
  return value === null ? "Not set" : formatPercent(value, 2);
}

async function request(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || result.ok === false) {
      return { ok: false, error: result.error ?? `Request failed (${response.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

function SummaryMetric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "positive" | "negative";
}) {
  const color = tone === "positive"
    ? "text-[var(--color-success)]"
    : tone === "negative"
      ? "text-[var(--color-danger)]"
      : "text-[var(--color-ink)]";
  return (
    <div className="card min-h-28 px-4 py-4">
      <p className="eyebrow">{label}</p>
      <p className={`tnum mt-2 text-2xl font-semibold ${color}`}>{formatMoney(value)}</p>
      <p className="mt-1 text-xs leading-5 text-[var(--color-ink-faint)]">{detail}</p>
    </div>
  );
}

function SimpleTable({
  headers,
  children,
  caption,
}: {
  headers: { label: string; numeric?: boolean }[];
  children: ReactNode;
  caption: string;
}) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead><tr className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)]">
          {headers.map((header) => <Th key={header.label} numeric={header.numeric}>{header.label}</Th>)}
        </tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

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

function IncomeForm({
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
  onOpenProgramSplit: (selection: { individualId: string; programId: string }) => void;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = sourceType === "custom_program";

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
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "The income could not be recorded.");
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
        <Field label={custom ? "Individual (required)" : "Individual (optional)"}>
          <select required={custom} className="select mt-1 w-full" value={individualId} onChange={(event) => setIndividualId(event.target.value)}>
            <option value="">None</option>
            {options.individuals.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </Field>
        <Field label={custom ? "Program (required)" : "Program (optional)"}>
          <select required={custom} className="select mt-1 w-full" value={programId} onChange={(event) => setProgramId(event.target.value)}>
            <option value="">None</option>
            {options.programs.map((item) => <option key={item.id} value={item.id}>{item.label}{item.code ? ` (${item.code})` : ""}</option>)}
          </select>
        </Field>
      </div>
      {!custom ? <Field label="Agency share (%)"><input className="input tnum mt-1 w-full" inputMode="decimal" value={agencySharePercent} onChange={(event) => setAgencySharePercent(event.target.value)} /></Field> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reference (optional)">
          <input className="input mt-1 w-full" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} />
        </Field>
        <Field label="Budget override reason (only if needed)">
          <input className="input mt-1 w-full" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} />
        </Field>
      </div>
      <Field label="Notes (optional)">
        <textarea className="input mt-1 min-h-20 w-full py-2" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>
      {sourceType === "class" ? (
        <Notice tone="info">Issued invoices are included automatically. Record only class income that is not already an issued invoice.</Notice>
      ) : null}
      {custom ? (
        <Notice
          tone="info"
          title="The saved program split is authoritative"
          action={individualId && programId ? <button type="button" className="btn btn-sm btn-secondary" onClick={() => onOpenProgramSplit({ individualId, programId })}>Open program split</button> : undefined}
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

function ProgramSplitForm({
  options,
  initial,
  onClose,
  onSaved,
}: {
  options: AgencyFinancialOptions;
  initial?: { individualId: string; programId: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [individualId, setIndividualId] = useState(initial?.individualId ?? options.individuals[0]?.id ?? "");
  const [programId, setProgramId] = useState(initial?.programId ?? options.programs[0]?.id ?? "");
  const [share, setShare] = useState("100");
  const [effectiveFrom, setEffectiveFrom] = useState(agencyDate());
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

function EmployeeTermForm({
  options,
  initial,
  onClose,
  onSaved,
}: {
  options: AgencyFinancialOptions;
  initial?: { employeeId: string; individualId: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(initial?.employeeId ?? options.employees[0]?.id ?? "");
  const [individualId, setIndividualId] = useState(initial?.individualId ?? options.individuals[0]?.id ?? "");
  const [share, setShare] = useState("100");
  const [effectiveFrom, setEffectiveFrom] = useState(agencyDate());
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

function VoidIncomeForm({ entry, onClose, onSaved }: { entry: ManualIncomeEntry; onClose: () => void; onSaved: () => void }) {
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
      <p className="text-sm text-[var(--color-ink-soft)]">Void {formatMoney(entry.grossAmount)} recorded on {entry.serviceDate}. The linked program-budget use will be reversed too.</p>
      <Field label="Reason"><input required minLength={5} className="input mt-1 w-full" value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      {error ? <p role="alert" className="text-sm font-medium text-[var(--color-danger)]">{error}</p> : null}
      <FormFooter saving={saving} onClose={onClose} />
    </form>
  );
}

export default function AgencyFinancialWorkspace({
  report,
  options,
  programTerms,
  employeeTerms,
  incomeHistory,
}: {
  report: AgencyFinancialReport;
  options: AgencyFinancialOptions;
  programTerms: ProgramRevenueTerm[];
  employeeTerms: EmployeeIndividualCompensationTerm[];
  incomeHistory: ManualIncomeEntry[];
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("summary");
  const [modal, setModal] = useState<Modal>(null);
  const [voidEntry, setVoidEntry] = useState<ManualIncomeEntry | null>(null);
  const [splitRepair, setSplitRepair] = useState<{ individualId: string; programId: string } | null>(null);
  const [payRuleRepair, setPayRuleRepair] = useState<{ employeeId: string; individualId: string } | null>(null);
  const issueCount = Object.values(report.coverage).reduce((sum, value) => sum + value, 0);
  const resultNegative = dec(report.totals.agencyResult).isNegative();
  const saved = () => {
    setModal(null);
    setVoidEntry(null);
    router.refresh();
  };
  const openProgramSplit = (selection: { individualId: string; programId: string } | null = null) => {
    setSplitRepair(selection);
    setModal("program-split");
  };
  const openPayRule = (selection: { employeeId: string; individualId: string } | null = null) => {
    setPayRuleRepair(selection);
    setModal("employee-term");
  };

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 border-b border-[var(--color-rule)] pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <Link className="btn btn-icon btn-secondary" aria-label="Previous month" title="Previous month" href={`/reports/agency-financials?month=${shiftMonth(report.month, -1)}`}><ChevronLeft className="h-4 w-4" aria-hidden /></Link>
          <div className="min-w-44 text-center">
            <p className="display text-lg font-semibold text-[var(--color-ink)]">{monthLabel(report.month)}</p>
            <p className="text-xs text-[var(--color-ink-faint)]">{report.periodStart} to {report.periodEnd}</p>
          </div>
          <Link className="btn btn-icon btn-secondary" aria-label="Next month" title="Next month" href={`/reports/agency-financials?month=${shiftMonth(report.month, 1)}`}><ChevronRight className="h-4 w-4" aria-hidden /></Link>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => openProgramSplit()}><Split className="h-4 w-4" aria-hidden /> Program split</button>
          <button type="button" className="btn btn-secondary" onClick={() => openPayRule()}><Users className="h-4 w-4" aria-hidden /> Employee pay rule</button>
          <button type="button" className="btn btn-primary" onClick={() => setModal("income")}><Plus className="h-4 w-4" aria-hidden /> Add income</button>
        </div>
      </div>

      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--color-rule)]" role="tablist" aria-label="Agency financial report sections">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            onClick={() => setView(item.id)}
            className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${view === item.id ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}
          >{item.label}</button>
        ))}
      </div>

      {view === "summary" ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryMetric label="Actual income" value={report.totals.income.total} detail="Transactions, issued class invoices, and recorded other income" />
            <SummaryMetric label="Expenses" value={report.totals.expenses.total} detail="Set-asides, taxes, employee shares, and individual shares" />
            <SummaryMetric label="Agency result" value={report.totals.agencyResult} detail="Actual income minus the listed expenses" tone={resultNegative ? "negative" : "positive"} />
          </div>

          {issueCount > 0 ? (
            <Notice tone="warning" title={`${issueCount} item${issueCount === 1 ? "" : "s"} excluded from one or more calculations`}>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {report.coverage.transactionsMissingAmount ? <button className="underline" type="button" onClick={() => setView("transactions")}>{report.coverage.transactionsMissingAmount} missing transaction amount</button> : null}
                {report.coverage.agencyTransactionsMissingBase ? <button className="underline" type="button" onClick={() => setView("transactions")}>{report.coverage.agencyTransactionsMissingBase} missing employee base</button> : null}
                {report.coverage.agencyTransactionsMissingPayRule ? <button className="underline" type="button" onClick={() => setView("transactions")}>{report.coverage.agencyTransactionsMissingPayRule} missing agency-routed pay rule</button> : null}
                {report.coverage.directChecksMissingGross ? <button className="underline" type="button" onClick={() => setView("checks")}>{report.coverage.directChecksMissingGross} missing check gross</button> : null}
                {report.coverage.directChecksGrossBelowNet ? <button className="underline" type="button" onClick={() => setView("checks")}>{report.coverage.directChecksGrossBelowNet} check gross below net</button> : null}
                {report.coverage.directChecksMissingDeal ? <button className="underline" type="button" onClick={() => setView("checks")}>{report.coverage.directChecksMissingDeal} missing direct-pay deal</button> : null}
                {report.coverage.classInvoicesMissingSplit ? <button className="underline" type="button" onClick={() => setView("other-income")}>{report.coverage.classInvoicesMissingSplit} missing class split</button> : null}
                {report.coverage.classInvoicesMissingProgram ? <button className="underline" type="button" onClick={() => setView("other-income")}>{report.coverage.classInvoicesMissingProgram} class invoice without a program</button> : null}
                {report.coverage.setupsMissingApprovedFinal ? <button className="underline" type="button" onClick={() => setView("set-asides")}>{report.coverage.setupsMissingApprovedFinal} setup without approved final</button> : null}
                {report.coverage.unknownPaymentRecipients ? <button className="underline" type="button" onClick={() => setView("transactions")}>{report.coverage.unknownPaymentRecipients} unknown payment recipient</button> : null}
              </div>
            </Notice>
          ) : (
            <Notice tone="success" title="All included records are fully configured">Every amount needed for this month has its source facts and pay rules.</Notice>
          )}

          <div className="grid gap-5 xl:grid-cols-2">
            <section className="card overflow-hidden">
              <header className="border-b border-[var(--color-rule)] px-5 py-3.5"><h2 className="display text-base font-semibold">Income</h2></header>
              <SimpleTable caption="Income summary" headers={[{ label: "Source" }, { label: "Records", numeric: true }, { label: "Gross income", numeric: true }]}>
                <Tr><Td><button type="button" className="font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("transactions")}>Google Sheet transactions</button></Td><Td numeric>{report.transactions.length}</Td><Td numeric><Money value={report.totals.income.transactions} /></Td></Tr>
                <Tr><Td><button type="button" className="font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Issued class invoices</button></Td><Td numeric>{report.classInvoices.length}</Td><Td numeric><Money value={report.totals.income.classes} /></Td></Tr>
                <Tr><Td><button type="button" className="font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Recorded other income</button></Td><Td numeric>{report.manualIncome.length}</Td><Td numeric><Money value={report.totals.income.manual} /></Td></Tr>
                <tr className="border-t border-[var(--color-rule-strong)] font-semibold"><Td>Total income</Td><Td numeric>{report.transactions.length + report.classInvoices.length + report.manualIncome.length}</Td><Td numeric><Money value={report.totals.income.total} /></Td></tr>
              </SimpleTable>
            </section>

            <section className="card overflow-hidden">
              <header className="border-b border-[var(--color-rule)] px-5 py-3.5"><h2 className="display text-base font-semibold">Expenses</h2></header>
              <SimpleTable caption="Expense summary" headers={[{ label: "Expense" }, { label: "Amount", numeric: true }]}>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("set-asides")}>Current approved monthly set-asides</button></Td><Td numeric><Money value={report.totals.expenses.approvedSetAsides} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("checks")}>Payroll taxes (gross - net)</button></Td><Td numeric><Money value={report.totals.expenses.taxes} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("checks")}>Direct-pay employee keeps</button></Td><Td numeric><Money value={report.totals.expenses.directEmployeeKeeps} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("transactions")}>Agency-routed employee share</button></Td><Td numeric><Money value={report.totals.expenses.agencyRoutedEmployeeShare} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Class income individual share</button></Td><Td numeric><Money value={report.totals.expenses.classIndividualShare} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Other income individual share</button></Td><Td numeric><Money value={report.totals.expenses.manualIndividualShare} /></Td></Tr>
                <tr className="border-t border-[var(--color-rule-strong)] font-semibold"><Td>Total expenses</Td><Td numeric><Money value={report.totals.expenses.total} /></Td></tr>
              </SimpleTable>
            </section>
          </div>
        </div>
      ) : null}

      {view === "transactions" ? (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5">
            <div><h2 className="display text-base font-semibold">Transaction actuals</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Gross income is the imported amount. Agency-routed employee expense uses Employee base, never the funder spread.</p></div>
            <Link className="btn btn-sm btn-secondary" href={`/transactions?pbFrom=${report.periodStart}&pbTo=${report.periodEnd}`}><ReceiptText className="h-4 w-4" aria-hidden /> Open transactions</Link>
          </header>
          {report.transactions.length ? <SimpleTable caption="Transaction actuals" headers={[{ label: "Date" }, { label: "Individual" }, { label: "Employee" }, { label: "Program" }, { label: "Paid to" }, { label: "Gross", numeric: true }, { label: "Employee base", numeric: true }, { label: "Pay rule" }, { label: "Employee expense", numeric: true }, { label: "" }]}>
            {report.transactions.map((row) => <Tr key={row.id}>
              <Td>{row.serviceDate}</Td><Td>{row.individualName ?? "Unmatched"}</Td><Td>{row.employeeName ?? "Unmatched"}</Td><Td>{row.programName ?? "Unmatched"}</Td><Td>{row.paymentRecipient === "excellent_staffing" ? "Agency" : row.paymentRecipient === "employee" ? "Employee" : "Unknown"}</Td>
              <Td numeric><Money value={row.grossAmount} /></Td><Td numeric><Money value={row.baseAmount} /></Td>
              <Td>{row.payRuleSource === null
                ? "Direct check"
                : row.payRuleSource === "person_rule"
                  ? `Person rule ${percent(row.employeeSharePercent)}`
                  : row.payRuleSource === "employee_default"
                    ? `Employee default ${percent(row.employeeSharePercent)}`
                    : row.employeeId && row.individualId
                      ? <button type="button" className="font-semibold text-[var(--color-danger)] underline" onClick={() => openPayRule({ employeeId: row.employeeId!, individualId: row.individualId! })}>Set pay rule</button>
                      : <span className="font-medium text-[var(--color-danger)]">Missing people</span>}</Td>
              <Td numeric><Money value={row.employeeExpense} /></Td><Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={`/transactions?transactionId=${row.id}`}>View</Link></Td>
            </Tr>)}
          </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No transaction actuals in this month.</p>}
        </section>
      ) : null}

      {view === "checks" ? (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Verified direct-pay checks</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Each check is counted once. Taxes are gross minus net; employee share is calculated from net.</p></div><Link className="btn btn-sm btn-secondary" href="/masser?view=checks"><HandCoins className="h-4 w-4" aria-hidden /> Open checks</Link></header>
          {report.directChecks.length ? <SimpleTable caption="Verified direct-pay checks" headers={[{ label: "Date" }, { label: "Employee" }, { label: "Check" }, { label: "Gross", numeric: true }, { label: "Net", numeric: true }, { label: "Taxes", numeric: true }, { label: "Deal" }, { label: "Employee keeps", numeric: true }, { label: "Agency receives", numeric: true }, { label: "" }]}>
            {report.directChecks.map((row) => <Tr key={row.id}><Td>{row.serviceDate}</Td><Td>{row.employeeName}</Td><Td>{row.checkNumber ?? "No number"}</Td><Td numeric><Money value={row.grossAmount} /></Td><Td numeric><Money value={row.netAmount} /></Td><Td numeric><Money value={row.taxes} /></Td><Td>{row.dealLabel ?? <Link className="font-semibold text-[var(--color-danger)] underline" href={`/employees/${row.employeeId}?view=deal`}>Set employee deal</Link>}</Td><Td numeric><Money value={row.employeeKeeps} /></Td><Td numeric><Money value={row.employeeOwesAgency} /></Td><Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={`/masser?view=checks&employeeId=${row.employeeId}`}>View</Link></Td></Tr>)}
          </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No verified direct-pay checks in this month.</p>}
        </section>
      ) : null}

      {view === "set-asides" ? (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Current approved monthly set-asides</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">The current Approved final is applied once to the selected month. Historical setup revisions are not reconstructed. Cut 1 and Cut 2 are traceability only.</p></div><Link className="btn btn-sm btn-secondary" href="/calculations"><Settings2 className="h-4 w-4" aria-hidden /> Financial setup</Link></header>
          {report.setAsides.length ? <SimpleTable caption="Monthly set-asides" headers={[{ label: "Individual" }, { label: "Setup" }, { label: "Cut 1" }, { label: "Cut 2" }, { label: "Approved final / month", numeric: true }, { label: "" }]}>
            {report.setAsides.map((row) => <Tr key={row.strategyId}><Td>{row.individualName}</Td><Td>{row.setupName}</Td><Td>{percent(row.firstCutPercent)}</Td><Td>{percent(row.secondCutPercent)}</Td><Td numeric>{row.approvedMonthlyFinal === null ? <Link className="font-semibold text-[var(--color-danger)] underline" href={`/individuals/${row.individualId}?view=financial`}>Set approved final</Link> : <Money value={row.approvedMonthlyFinal} />}</Td><Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={`/individuals/${row.individualId}?view=financial`}>View</Link></Td></Tr>)}
          </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No active financial setups.</p>}
        </section>
      ) : null}

      {view === "other-income" ? (
        <div className="space-y-5">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Issued class invoices</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Issued invoices are included automatically and never need a second income entry.</p></div><Link className="btn btn-sm btn-secondary" href={`/classes?month=${report.month}`}><CalendarDays className="h-4 w-4" aria-hidden /> Open classes</Link></header>
            {report.classInvoices.length ? <SimpleTable caption="Issued class invoice income" headers={[{ label: "Invoice" }, { label: "Date" }, { label: "Individual" }, { label: "Program" }, { label: "Gross", numeric: true }, { label: "Agency split" }, { label: "Agency amount", numeric: true }, { label: "Individual expense", numeric: true }]}>
              {report.classInvoices.map((row) => <Tr key={row.id}><Td>{row.invoiceNumber}</Td><Td>{row.invoiceDate}</Td><Td>{row.individualName}</Td><Td>{row.programName ?? "Not linked"}</Td><Td numeric><Money value={row.grossAmount} /></Td><Td>{row.splitSource === "missing" && row.programId ? <button type="button" className="font-semibold text-[var(--color-danger)] underline" onClick={() => openProgramSplit({ individualId: row.individualId, programId: row.programId! })}>Set effective split</button> : row.splitSource === "missing" ? <span className="font-medium text-[var(--color-danger)]">Link program first</span> : row.splitSource === "full_agency_default" ? "100% default" : percent(row.agencySharePercent)}</Td><Td numeric><Money value={row.agencyAmount} /></Td><Td numeric><Money value={row.individualExpense} /></Td></Tr>)}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No issued class invoices in this month.</p>}
          </section>

          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Recorded other income</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Reimbursements, custom programs, and income not present in the Google Sheet or issued invoices.</p></div><button type="button" className="btn btn-sm btn-primary" onClick={() => setModal("income")}><Plus className="h-4 w-4" aria-hidden /> Add income</button></header>
            {incomeHistory.length ? <SimpleTable caption="Recorded other income" headers={[{ label: "Date" }, { label: "Type" }, { label: "Individual / program" }, { label: "Reference" }, { label: "Gross", numeric: true }, { label: "Agency", numeric: true }, { label: "Individual expense", numeric: true }, { label: "Status" }, { label: "" }]}>
              {incomeHistory.map((row) => <Tr key={row.id}><Td>{row.serviceDate}</Td><Td>{SOURCE_LABEL[row.sourceType]}</Td><Td>{[row.individualName, row.programName].filter(Boolean).join(" / ") || "General"}</Td><Td>{row.sourceRef ?? "-"}</Td><Td numeric><Money value={row.grossAmount} /></Td><Td numeric><Money value={row.agencyAmount} /></Td><Td numeric><Money value={row.individualAmount} /></Td><Td>{row.status === "active" ? "Active" : <span className="text-[var(--color-ink-faint)]">Voided</span>}</Td><Td>{row.status === "active" ? <button type="button" className="btn btn-icon btn-ghost text-[var(--color-danger)]" aria-label="Void income" title="Void income" onClick={() => setVoidEntry(row)}><Trash2 className="h-4 w-4" aria-hidden /></button> : null}</Td></Tr>)}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No other income recorded in this month.</p>}
          </section>
        </div>
      ) : null}

      {view === "rules" ? (
        <div className="space-y-5">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Individual program splits</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">The agency percentage for non-payroll income assigned to one individual and program.</p></div><button type="button" className="btn btn-sm btn-secondary" onClick={() => openProgramSplit()}><Plus className="h-4 w-4" aria-hidden /> Add split</button></header>
            {programTerms.length ? <SimpleTable caption="Individual program splits" headers={[{ label: "Individual" }, { label: "Program" }, { label: "Agency share" }, { label: "Starts" }, { label: "Ends" }, { label: "Authorized", numeric: true }, { label: "Remaining", numeric: true }]}>
              {programTerms.map((term) => <Tr key={term.id}><Td>{term.individualName}</Td><Td>{term.programName} ({term.programCode})</Td><Td>{percent(term.agencySharePercent)}</Td><Td>{term.effectiveFrom}</Td><Td>{term.effectiveTo ?? "Open"}</Td><Td numeric><Money value={term.authorizedDollars} /></Td><Td numeric><Money value={term.remainingDollars} /></Td></Tr>)}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No program splits have been saved.</p>}
          </section>
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Employee and individual pay rules</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Specific rules take priority over the employee's general agency-routed deal.</p></div><button type="button" className="btn btn-sm btn-secondary" onClick={() => openPayRule()}><Plus className="h-4 w-4" aria-hidden /> Add pay rule</button></header>
            {employeeTerms.length ? <SimpleTable caption="Employee and individual pay rules" headers={[{ label: "Employee" }, { label: "Individual" }, { label: "Employee share of base" }, { label: "Starts" }, { label: "Ends" }, { label: "Notes" }]}>
              {employeeTerms.map((term) => <Tr key={term.id}><Td>{term.employeeName}</Td><Td>{term.individualName}</Td><Td>{percent(term.employeeSharePercent)}</Td><Td>{term.effectiveFrom}</Td><Td>{term.effectiveTo ?? "Open"}</Td><Td>{term.notes ?? "-"}</Td></Tr>)}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No employee-person pay rules have been saved.</p>}
          </section>
        </div>
      ) : null}

      {modal === "income" ? <ModalShell title="Add actual income" onClose={() => setModal(null)}><IncomeForm month={report.month} options={options} onClose={() => setModal(null)} onSaved={saved} onOpenProgramSplit={(selection) => openProgramSplit(selection)} /></ModalShell> : null}
      {modal === "program-split" ? <ModalShell title="Set individual program split" onClose={() => setModal(null)}><ProgramSplitForm options={options} initial={splitRepair} onClose={() => setModal(null)} onSaved={saved} /></ModalShell> : null}
      {modal === "employee-term" ? <ModalShell title="Set employee pay rule" onClose={() => setModal(null)}><EmployeeTermForm options={options} initial={payRuleRepair} onClose={() => setModal(null)} onSaved={saved} /></ModalShell> : null}
      {voidEntry ? <ModalShell title="Void income entry" onClose={() => setVoidEntry(null)}><VoidIncomeForm entry={voidEntry} onClose={() => setVoidEntry(null)} onSaved={saved} /></ModalShell> : null}
    </>
  );
}

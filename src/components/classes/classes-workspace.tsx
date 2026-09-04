"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Download,
  Eye,
  FilePenLine,
  FilePlus2,
  FileText,
  Library,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import InvoiceBuilder, { classRequest } from "./invoice-builder";
import ClassCoverSheetDialog from "./class-cover-sheet-dialog";
import { ModalShell } from "@/components/schedule/shared";
import type {
  ClassActivityRecord,
  ClassBudgetRecord,
  ClassInvoiceRecord,
} from "@/lib/data/class-invoices";
import { dec, formatMoney } from "@/lib/money";

type InvoiceSummary = Omit<ClassInvoiceRecord, "lines">;
type WorkspaceView = "monthly" | "budgets" | "activities";

interface Picker {
  id: string;
  label: string;
}

interface IssueWarning {
  invoice: InvoiceSummary;
  message: string;
  overageAmount: string;
}

const STATUS_CLASS: Record<string, string> = {
  draft: "border-[var(--color-warn)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  issued: "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
  void: "border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] text-[var(--color-ink-faint)]",
  active: "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
  closed: "border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] text-[var(--color-ink-faint)]",
};

function monthName(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`));
}

function monthEnd(month: string): string {
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, part!, 0)).toISOString().slice(0, 10);
}

function shiftMonth(month: string, amount: number): string {
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, part! - 1 + amount, 1)).toISOString().slice(0, 7);
}

function statusLabel(status: string): string {
  return status === "void" ? "Voided" : `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge border ${STATUS_CLASS[status] ?? STATUS_CLASS.closed}`}>{statusLabel(status)}</span>;
}

function InvoicePdfActions({
  invoice,
  canManage,
  canEditDocuments,
  subtle = false,
}: {
  invoice: InvoiceSummary;
  canManage: boolean;
  canEditDocuments: boolean;
  subtle?: boolean;
}) {
  const buttonClass = `btn btn-sm ${subtle ? "btn-ghost" : "btn-secondary"} btn-icon`;
  if (invoice.status === "draft") {
    return canManage ? (
      <a
        className={buttonClass}
        href={`/api/classes/invoices/${invoice.id}/pdf?preview=1`}
        target="_blank"
        rel="noreferrer"
        aria-label="Preview draft invoice PDF"
        title="Preview draft invoice PDF"
      >
        <Eye className="h-4 w-4" aria-hidden />
      </a>
    ) : null;
  }
  if (invoice.status !== "issued") return null;
  const source = `/api/classes/invoices/${invoice.id}/pdf`;
  return (
    <>
      <a className={buttonClass} href={source} aria-label="Download invoice PDF" title="Download invoice PDF">
        <Download className="h-4 w-4" aria-hidden />
      </a>
      {canManage && canEditDocuments ? (
        <Link
          className={buttonClass}
          href={`/documents/pdf-editor?source=${encodeURIComponent(source)}`}
          aria-label="Edit or save invoice PDF in Documents"
          title="Edit or save invoice PDF in Documents"
        >
          <FilePenLine className="h-4 w-4" aria-hidden />
        </Link>
      ) : null}
    </>
  );
}

function percentage(consumed: string, authorized: string): number {
  try {
    const total = dec(authorized);
    if (total.lte(0)) return 0;
    return Math.max(0, Math.min(100, dec(consumed).dividedBy(total).times(100).toNumber()));
  } catch {
    return 0;
  }
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 border-l-2 border-[var(--color-primary)] pl-3">
      <p className="eyebrow">{label}</p>
      <p className="tnum mt-1 truncate text-xl font-semibold text-[var(--color-ink)]">{value}</p>
      {detail ? <p className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">{detail}</p> : null}
    </div>
  );
}

function BudgetForm({
  individuals,
  budget,
  initialIndividualId,
  onClose,
  onSaved,
}: {
  individuals: Picker[];
  budget?: ClassBudgetRecord | null;
  initialIndividualId?: string | null;
  onClose: () => void;
  onSaved: (budget: ClassBudgetRecord) => void;
}) {
  const currentYear = new Date().getUTCFullYear();
  const [individualId, setIndividualId] = useState(budget?.individualId ?? initialIndividualId ?? individuals[0]?.id ?? "");
  const [label, setLabel] = useState(budget?.label ?? `${currentYear} class allowance`);
  const [startDate, setStartDate] = useState(budget?.startDate ?? `${currentYear}-01-01`);
  const [endDate, setEndDate] = useState(budget?.endDate ?? `${currentYear}-12-31`);
  const [authorizedAmount, setAuthorizedAmount] = useState(budget?.authorizedAmount ?? "20000");
  const [status, setStatus] = useState<"active" | "closed">(budget?.status ?? "active");
  const [notes, setNotes] = useState(budget?.notes ?? "");
  const [overrideReason, setOverrideReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await classRequest<ClassBudgetRecord>(
      budget ? `/api/classes/budgets/${budget.id}` : "/api/classes/budgets",
      budget ? "PATCH" : "POST",
      budget
        ? { label, authorizedAmount, status, notes: notes || null, overBudgetOverrideReason: overrideReason || null }
        : { individualId, label, startDate, endDate, authorizedAmount, notes: notes || null },
    );
    setSaving(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not save the class budget.");
      return;
    }
    onSaved(result.data);
  };

  return (
    <ModalShell title={budget ? "Edit class allowance" : "Add class allowance"} onClose={onClose}>
      <div className="space-y-4">
        {!budget ? (
          <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
            Individual
            <select className="select mt-1 w-full" value={individualId} onChange={(event) => setIndividualId(event.target.value)}>
              {individuals.map((individual) => <option key={individual.id} value={individual.id}>{individual.label}</option>)}
            </select>
          </label>
        ) : null}
        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
          Label
          <input className="input mt-1 w-full" value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        {!budget ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
              Starts
              <input className="input mt-1 w-full" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
              Ends
              <input className="input mt-1 w-full" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </label>
          </div>
        ) : null}
        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
          Authorized amount
          <input className="input tnum mt-1 w-full" inputMode="decimal" value={authorizedAmount} onChange={(event) => setAuthorizedAmount(event.target.value)} />
        </label>
        {budget ? (
          <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
            Status
            <select className="select mt-1 w-full" value={status} onChange={(event) => setStatus(event.target.value as "active" | "closed")}>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
            </select>
          </label>
        ) : null}
        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
          Notes
          <textarea className="input mt-1 min-h-20 w-full py-2" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {budget ? (
          <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
            Override reason
            <input className="input mt-1 w-full" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} />
          </label>
        ) : null}
        {error ? <p className="text-sm font-medium text-[var(--color-danger)]" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-[var(--color-rule)] pt-4">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || !individualId}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ActivityForm({
  activity,
  onClose,
  onSaved,
}: {
  activity?: ClassActivityRecord | null;
  onClose: () => void;
  onSaved: (activity: ClassActivityRecord) => void;
}) {
  const [code, setCode] = useState(activity?.code ?? "");
  const [name, setName] = useState(activity?.name ?? "");
  const [description, setDescription] = useState(activity?.description ?? "");
  const [rate, setRate] = useState(activity?.defaultUnitPrice ?? "150");
  const [active, setActive] = useState(activity?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await classRequest<ClassActivityRecord>(
      activity ? `/api/classes/activities/${activity.id}` : "/api/classes/activities",
      activity ? "PATCH" : "POST",
      { code, name, description: description || null, defaultUnitPrice: rate, isActive: active },
    );
    setSaving(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not save the class activity.");
      return;
    }
    onSaved(result.data);
  };

  return (
    <ModalShell title={activity ? "Edit activity" : "Add activity"} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Code
            <input className="input mt-1 w-full" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Name
            <input className="input mt-1 w-full" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>
        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
          Default price
          <input className="input tnum mt-1 w-full" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
        </label>
        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
          Description
          <textarea className="input mt-1 min-h-20 w-full py-2" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          Active
        </label>
        {error ? <p className="text-sm font-medium text-[var(--color-danger)]" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-[var(--color-rule)] pt-4">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
        </div>
      </div>
    </ModalShell>
  );
}

function ReasonDialog({
  title,
  warning,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  warning?: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalShell title={title} onClose={onClose}>
      <div className="space-y-4">
        {warning ? <p className="rounded-md border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn)]">{warning}</p> : null}
        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
          Reason
          <textarea className="input mt-1 min-h-24 w-full py-2" value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        {error ? <p className="text-sm font-medium text-[var(--color-danger)]" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || reason.trim().length < 5}
            onClick={() => {
              setSaving(true);
              setError(null);
              void onConfirm(reason.trim()).catch((caught) => {
                setSaving(false);
                setError(caught instanceof Error ? caught.message : "Could not complete this action.");
              });
            }}
          >
            {saving ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ConfirmDiscardDialog({
  invoice,
  onClose,
  onConfirm,
}: {
  invoice: InvoiceSummary;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalShell title={`Discard ${invoice.invoiceNumber}?`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-ink-soft)]">
          This removes the draft and its class dates. Issued totals and the annual allowance will not change.
        </p>
        {error ? <p className="text-sm font-medium text-[var(--color-danger)]" role="alert">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-rule)] pt-4">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Keep draft</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void onConfirm().catch((caught) => {
                setSaving(false);
                setError(caught instanceof Error ? caught.message : "Could not discard this draft.");
              });
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            {saving ? "Discarding..." : "Discard draft"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export default function ClassesWorkspace({
  initialMonth,
  activities: initialActivities,
  budgets: initialBudgets,
  invoices: initialInvoices,
  individuals,
  canManage,
  canEditDocuments,
}: {
  initialMonth: string;
  activities: ClassActivityRecord[];
  budgets: ClassBudgetRecord[];
  invoices: InvoiceSummary[];
  individuals: Picker[];
  canManage: boolean;
  canEditDocuments: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<WorkspaceView>("monthly");
  const [month, setMonth] = useState(initialMonth);
  const [search, setSearch] = useState("");
  const [activities, setActivities] = useState(initialActivities);
  const [budgets, setBudgets] = useState(initialBudgets);
  const [invoices, setInvoices] = useState(initialInvoices);
  const [budgetForm, setBudgetForm] = useState<ClassBudgetRecord | "new" | null>(null);
  const [newBudgetIndividualId, setNewBudgetIndividualId] = useState<string | null>(null);
  const [activityForm, setActivityForm] = useState<ClassActivityRecord | "new" | null>(null);
  const [invoiceBudget, setInvoiceBudget] = useState<ClassBudgetRecord | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<ClassInvoiceRecord | null>(null);
  const [loadingInvoiceId, setLoadingInvoiceId] = useState<string | null>(null);
  const [issueWarning, setIssueWarning] = useState<IssueWarning | null>(null);
  const [voidInvoice, setVoidInvoice] = useState<InvoiceSummary | null>(null);
  const [discardInvoice, setDiscardInvoice] = useState<InvoiceSummary | null>(null);
  const [coverInvoice, setCoverInvoice] = useState<InvoiceSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setActivities(initialActivities), [initialActivities]);
  useEffect(() => setBudgets(initialBudgets), [initialBudgets]);
  useEffect(() => setInvoices(initialInvoices), [initialInvoices]);

  const monthStart = `${month}-01`;
  const monthFinish = monthEnd(month);
  const normalizedSearch = search.trim().toLowerCase();
  const budgetsForMonth = useMemo(
    () => budgets.filter((budget) => (
      budget.status === "active"
      && budget.startDate <= monthFinish
      && budget.endDate >= monthStart
      && (!normalizedSearch || budget.individualName.toLowerCase().includes(normalizedSearch))
    )),
    [budgets, monthFinish, monthStart, normalizedSearch],
  );
  const invoicesForMonth = useMemo(
    () => invoices.filter((invoice) => (
      invoice.servicePeriodStart <= monthFinish
      && invoice.servicePeriodEnd >= monthStart
      && (!normalizedSearch
        || invoice.individualName.toLowerCase().includes(normalizedSearch)
        || invoice.invoiceNumber.toLowerCase().includes(normalizedSearch))
    )),
    [invoices, monthFinish, monthStart, normalizedSearch],
  );
  const invoiceByBudget = useMemo(() => {
    const map = new Map<string, InvoiceSummary[]>();
    for (const invoice of invoicesForMonth) {
      const current = map.get(invoice.classBudgetPeriodId) ?? [];
      current.push(invoice);
      map.set(invoice.classBudgetPeriodId, current);
    }
    return map;
  }, [invoicesForMonth]);
  const authorized = useMemo(() => budgetsForMonth.reduce((sum, budget) => sum.plus(budget.authorizedAmount), dec(0)), [budgetsForMonth]);
  const consumed = useMemo(() => budgetsForMonth.reduce((sum, budget) => sum.plus(budget.consumedAmount), dec(0)), [budgetsForMonth]);
  const remaining = useMemo(() => budgetsForMonth.reduce((sum, budget) => sum.plus(budget.remainingAmount), dec(0)), [budgetsForMonth]);
  const monthIssued = useMemo(() => invoicesForMonth.filter((invoice) => invoice.status === "issued").reduce((sum, invoice) => sum.plus(invoice.totalAmount), dec(0)), [invoicesForMonth]);
  const monthDrafts = useMemo(() => invoicesForMonth.filter((invoice) => invoice.status === "draft").reduce((sum, invoice) => sum.plus(invoice.totalAmount), dec(0)), [invoicesForMonth]);
  const activeBudgetPeople = useMemo(() => new Set(budgets.filter((budget) => (
    budget.status === "active"
    && budget.startDate <= monthFinish
    && budget.endDate >= monthStart
  )).map((budget) => budget.individualId)), [budgets, monthFinish, monthStart]);
  const peopleWithoutBudget = useMemo(() => individuals.filter((individual) => !activeBudgetPeople.has(individual.id)), [activeBudgetPeople, individuals]);

  const replaceBudget = (next: ClassBudgetRecord) => {
    setBudgets((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? next : item)
      : [next, ...current]);
    setBudgetForm(null);
    router.refresh();
  };

  const replaceActivity = (next: ClassActivityRecord) => {
    setActivities((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? next : item)
      : [...current, next]);
    setActivityForm(null);
    router.refresh();
  };

  const replaceInvoice = (next: ClassInvoiceRecord) => {
    const summary: InvoiceSummary = next;
    setInvoices((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? summary : item)
      : [summary, ...current]);
    setEditingInvoice(null);
    setInvoiceBudget(null);
    router.refresh();
  };

  const editInvoice = async (invoice: InvoiceSummary) => {
    setLoadingInvoiceId(invoice.id);
    setError(null);
    const result = await classRequest<ClassInvoiceRecord>(`/api/classes/invoices/${invoice.id}`);
    setLoadingInvoiceId(null);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not open the invoice.");
      return;
    }
    const budget = budgets.find((item) => item.id === result.data!.classBudgetPeriodId);
    if (!budget) {
      setError("The class allowance for this invoice is unavailable.");
      return;
    }
    setInvoiceBudget(budget);
    setEditingInvoice(result.data);
  };

  const issue = async (invoice: InvoiceSummary, overrideReason?: string) => {
    setBusyId(invoice.id);
    setError(null);
    const result = await classRequest<ClassInvoiceRecord>(
      `/api/classes/invoices/${invoice.id}/issue`,
      "POST",
      overrideReason ? { overBudgetOverrideReason: overrideReason, reason: overrideReason } : {},
    );
    setBusyId(null);
    if (!result.ok || !result.data) {
      if (result.details?.kind === "class_budget_overage") {
        setIssueWarning({
          invoice,
          message: result.error ?? "This invoice exceeds the annual allowance.",
          overageAmount: result.details.overageAmount ?? "0",
        });
        return;
      }
      throw new Error(result.error ?? "Could not issue the invoice.");
    }
    replaceInvoice(result.data);
    setIssueWarning(null);
  };

  const voidIssued = async (invoice: InvoiceSummary, reason: string) => {
    setBusyId(invoice.id);
    const result = await classRequest<ClassInvoiceRecord>(`/api/classes/invoices/${invoice.id}/void`, "POST", { reason });
    setBusyId(null);
    if (!result.ok || !result.data) throw new Error(result.error ?? "Could not void the invoice.");
    replaceInvoice(result.data);
    setVoidInvoice(null);
  };

  const discardDraft = async (invoice: InvoiceSummary) => {
    setBusyId(invoice.id);
    const result = await classRequest<{ id: string }>(`/api/classes/invoices/${invoice.id}`, "DELETE");
    setBusyId(null);
    if (!result.ok) throw new Error(result.error ?? "Could not discard this draft.");
    setInvoices((current) => current.filter((item) => item.id !== invoice.id));
    setDiscardInvoice(null);
    router.refresh();
  };

  const setMonthAndUrl = (next: string) => {
    setMonth(next);
    const url = new URL(window.location.href);
    url.searchParams.set("month", next);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-[var(--color-rule)] pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="segmented-control w-full overflow-x-auto lg:w-auto" role="group" aria-label="Classes view">
          <button type="button" aria-pressed={view === "monthly"} onClick={() => setView("monthly")}><CalendarDays className="h-4 w-4" aria-hidden /> Monthly billing</button>
          <button type="button" aria-pressed={view === "budgets"} onClick={() => setView("budgets")}><CircleDollarSign className="h-4 w-4" aria-hidden /> Annual allowances</button>
          <button type="button" aria-pressed={view === "activities"} onClick={() => setView("activities")}><Library className="h-4 w-4" aria-hidden /> Activities</button>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => { setNewBudgetIndividualId(null); setBudgetForm("new"); }}><Plus className="h-4 w-4" aria-hidden /> Allowance</button>
            {view === "activities" ? <button type="button" className="btn btn-primary" onClick={() => setActivityForm("new")}><Plus className="h-4 w-4" aria-hidden /> Activity</button> : null}
          </div>
        ) : null}
      </div>

      {view === "monthly" ? (
        <>
          <div className="flex flex-col gap-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1">
              <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => setMonthAndUrl(shiftMonth(month, -1))} aria-label="Previous month" title="Previous month"><ChevronLeft className="h-4 w-4" aria-hidden /></button>
              <label className="min-w-0">
                <span className="sr-only">Billing month</span>
                <input className="input tnum w-40" type="month" value={month} onChange={(event) => setMonthAndUrl(event.target.value)} />
              </label>
              <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => setMonthAndUrl(shiftMonth(month, 1))} aria-label="Next month" title="Next month"><ChevronRight className="h-4 w-4" aria-hidden /></button>
              <span className="ml-2 hidden text-sm font-semibold sm:inline">{monthName(month)}</span>
            </div>
            <label className="relative block w-full sm:w-64">
              <span className="sr-only">Search individuals</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" aria-hidden />
              <input className="input input-leading-icon w-full" placeholder="Search individuals" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>

          <div className="grid gap-4 border-b border-[var(--color-rule)] pb-5 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Annual authorized" value={formatMoney(authorized.toString())} detail={`${budgetsForMonth.length} active allowances`} />
            <Metric label="Issued this month" value={formatMoney(monthIssued.toString())} detail={`${invoicesForMonth.filter((invoice) => invoice.status === "issued").length} invoices`} />
            <Metric label="Drafts" value={formatMoney(monthDrafts.toString())} detail={`${invoicesForMonth.filter((invoice) => invoice.status === "draft").length} awaiting issue`} />
            <Metric label="Annual remaining" value={formatMoney(remaining.toString())} detail={`${formatMoney(consumed.toString())} issued to date`} />
          </div>

          {error ? <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]" role="alert">{error}</div> : null}

          <div className="space-y-2 lg:hidden">
            {budgetsForMonth.map((budget) => {
              const monthInvoices = invoiceByBudget.get(budget.id) ?? [];
              const current = monthInvoices.find((invoice) => invoice.status === "draft")
                ?? monthInvoices.find((invoice) => invoice.status === "issued");
              const used = percentage(budget.consumedAmount, budget.authorizedAmount);
              return (
                <article key={budget.id} className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/individuals/${budget.individualId}?view=classes`} className="block truncate font-semibold text-[var(--color-ink)] hover:text-[var(--color-primary)]">{budget.individualName}</Link>
                      <p className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">{budget.label}</p>
                    </div>
                    {current ? <StatusBadge status={current.status} /> : <span className="whitespace-nowrap text-xs text-[var(--color-ink-faint)]">Not started</span>}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--color-rule)] pt-3">
                    <div className="min-w-0">
                      <p className="eyebrow">Annual allowance</p>
                      <p className="tnum mt-1 truncate text-sm font-semibold">{formatMoney(budget.authorizedAmount)}</p>
                    </div>
                    <div className="min-w-0 text-right">
                      <p className="eyebrow">Remaining</p>
                      <p className={`tnum mt-1 truncate text-sm font-semibold ${dec(budget.remainingAmount).isNegative() ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(budget.remainingAmount)}</p>
                    </div>
                    <div className="col-span-2">
                      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-[var(--color-ink-soft)]">
                        <span>Used {formatMoney(budget.consumedAmount)}</span>
                        <span className="tnum">{Math.round(used)}%</span>
                      </div>
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-[var(--color-rule)]"
                        role="progressbar"
                        aria-label={`${budget.individualName} annual allowance used`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(used)}
                      >
                        <span className="block h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${used}%` }} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-rule)] pt-3">
                    <div className="min-w-0">
                      <p className="text-xs text-[var(--color-ink-faint)]">{monthName(month)}</p>
                      {current ? <p className="tnum mt-0.5 text-sm font-semibold">{formatMoney(current.totalAmount)}</p> : null}
                      {monthInvoices.length > 1 ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{monthInvoices.length} records</p> : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {!current && canManage ? <button type="button" className="btn btn-sm btn-primary" onClick={() => { setEditingInvoice(null); setInvoiceBudget(budget); }}><FilePlus2 className="h-4 w-4" aria-hidden /> Draft</button> : null}
                      {current?.status === "draft" && canManage ? (
                        <>
                          <button type="button" className="btn btn-sm btn-secondary" disabled={loadingInvoiceId === current.id} onClick={() => void editInvoice(current)}><FilePenLine className="h-4 w-4" aria-hidden /> {loadingInvoiceId === current.id ? "Opening..." : "Edit"}</button>
                          <InvoicePdfActions invoice={current} canManage={canManage} canEditDocuments={canEditDocuments} />
                          <button type="button" className="btn btn-sm btn-primary" disabled={busyId === current.id} onClick={() => void issue(current).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not issue invoice."))}>Issue</button>
                          <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" disabled={busyId === current.id} onClick={() => setDiscardInvoice(current)} aria-label="Discard draft" title="Discard draft"><Trash2 className="h-4 w-4" aria-hidden /></button>
                        </>
                      ) : null}
                      {current?.status === "issued" ? (
                        <>
                          <InvoicePdfActions invoice={current} canManage={canManage} canEditDocuments={canEditDocuments} />
                          {canManage ? <button type="button" className="btn btn-sm btn-secondary btn-icon" onClick={() => setCoverInvoice(current)} aria-label="Reimbursement cover sheet" title="Reimbursement cover sheet"><FileText className="h-4 w-4" aria-hidden /></button> : null}
                          {canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" onClick={() => setVoidInvoice(current)} aria-label="Void invoice" title="Void invoice"><Ban className="h-4 w-4" aria-hidden /></button> : null}
                        </>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
            {budgetsForMonth.length === 0 ? <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-10 text-center text-sm text-[var(--color-ink-faint)]">No active class allowances for {monthName(month)}.</div> : null}
          </div>

          <div className="hidden overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] lg:block">
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead className="bg-[var(--color-surface-muted)] text-left text-[0.7rem] uppercase text-[var(--color-ink-faint)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Individual</th>
                    <th className="px-4 py-3 font-semibold">Annual allowance</th>
                    <th className="px-4 py-3 font-semibold">Used</th>
                    <th className="px-4 py-3 font-semibold">Remaining</th>
                    <th className="px-4 py-3 font-semibold">{monthName(month)}</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-rule)]">
                  {budgetsForMonth.map((budget) => {
                    const monthInvoices = invoiceByBudget.get(budget.id) ?? [];
                    const current = monthInvoices.find((invoice) => invoice.status === "draft")
                      ?? monthInvoices.find((invoice) => invoice.status === "issued");
                    const used = percentage(budget.consumedAmount, budget.authorizedAmount);
                    return (
                      <tr key={budget.id} className="hover:bg-[var(--color-surface-muted)]">
                        <td className="px-4 py-3">
                          <Link href={`/individuals/${budget.individualId}?view=classes`} className="font-semibold text-[var(--color-ink)] hover:text-[var(--color-primary)]">{budget.individualName}</Link>
                          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{budget.label}</p>
                        </td>
                        <td className="tnum px-4 py-3 font-medium">{formatMoney(budget.authorizedAmount)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div
                              className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-rule)]"
                              role="progressbar"
                              aria-label={`${budget.individualName} annual allowance used`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.round(used)}
                            >
                              <span className="block h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${used}%` }} />
                            </div>
                            <span className="tnum text-xs text-[var(--color-ink-soft)]">{Math.round(used)}%</span>
                          </div>
                        </td>
                        <td className={`tnum px-4 py-3 font-semibold ${dec(budget.remainingAmount).isNegative() ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(budget.remainingAmount)}</td>
                        <td className="px-4 py-3">
                          {current ? <div className="flex items-center gap-2"><StatusBadge status={current.status} /><span className="tnum font-semibold">{formatMoney(current.totalAmount)}</span></div> : <span className="text-[var(--color-ink-faint)]">Not started</span>}
                          {monthInvoices.length > 1 ? <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{monthInvoices.length} records</p> : null}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            {!current && canManage ? <button type="button" className="btn btn-sm btn-primary" onClick={() => { setEditingInvoice(null); setInvoiceBudget(budget); }}><FilePlus2 className="h-4 w-4" aria-hidden /> Draft</button> : null}
                            {current?.status === "draft" && canManage ? (
                              <>
                                <button type="button" className="btn btn-sm btn-secondary" disabled={loadingInvoiceId === current.id} onClick={() => void editInvoice(current)}><FilePenLine className="h-4 w-4" aria-hidden /> {loadingInvoiceId === current.id ? "Opening..." : "Edit"}</button>
                                <InvoicePdfActions invoice={current} canManage={canManage} canEditDocuments={canEditDocuments} />
                                <button type="button" className="btn btn-sm btn-primary" disabled={busyId === current.id} onClick={() => void issue(current).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not issue invoice."))}>Issue</button>
                                <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" disabled={busyId === current.id} onClick={() => setDiscardInvoice(current)} aria-label="Discard draft" title="Discard draft"><Trash2 className="h-4 w-4" aria-hidden /></button>
                              </>
                            ) : null}
                            {current?.status === "issued" ? (
                              <>
                                <InvoicePdfActions invoice={current} canManage={canManage} canEditDocuments={canEditDocuments} />
                                {canManage ? <button type="button" className="btn btn-sm btn-secondary btn-icon" onClick={() => setCoverInvoice(current)} aria-label="Reimbursement cover sheet" title="Reimbursement cover sheet"><FileText className="h-4 w-4" aria-hidden /></button> : null}
                                {canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" onClick={() => setVoidInvoice(current)} aria-label="Void invoice" title="Void invoice"><Ban className="h-4 w-4" aria-hidden /></button> : null}
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {budgetsForMonth.length === 0 ? <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-[var(--color-ink-faint)]">No active class allowances for {monthName(month)}.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>

          {invoicesForMonth.length > 0 ? (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold">Invoice history</h2>
                <span className="badge">{invoicesForMonth.length}</span>
              </div>
              <div className="space-y-2 lg:hidden">
                {invoicesForMonth.map((invoice) => (
                  <article key={invoice.id} className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{invoice.invoiceNumber}</p>
                        <Link className="mt-0.5 block truncate text-sm text-[var(--color-ink-soft)] hover:text-[var(--color-primary)]" href={`/individuals/${invoice.individualId}?view=classes`}>{invoice.individualName}</Link>
                      </div>
                      <p className="tnum whitespace-nowrap text-sm font-semibold">{formatMoney(invoice.totalAmount)}</p>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-rule)] pt-3">
                      <div>
                        <StatusBadge status={invoice.status} />
                        <p className="tnum mt-1.5 text-xs text-[var(--color-ink-faint)]">{invoice.servicePeriodStart} - {invoice.servicePeriodEnd}</p>
                      </div>
                      <div className="flex justify-end gap-1">
                        {invoice.status === "draft" && canManage ? (
                          <>
                            <button type="button" className="btn btn-sm btn-secondary" disabled={loadingInvoiceId === invoice.id} onClick={() => void editInvoice(invoice)}><Pencil className="h-4 w-4" aria-hidden /> {loadingInvoiceId === invoice.id ? "Opening..." : "Edit"}</button>
                            <InvoicePdfActions invoice={invoice} canManage={canManage} canEditDocuments={canEditDocuments} />
                            <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" disabled={busyId === invoice.id} onClick={() => setDiscardInvoice(invoice)} aria-label="Discard draft" title="Discard draft"><Trash2 className="h-4 w-4" aria-hidden /></button>
                          </>
                        ) : null}
                        {invoice.status === "issued" ? (
                          <>
                            <InvoicePdfActions invoice={invoice} canManage={canManage} canEditDocuments={canEditDocuments} />
                            {canManage ? <button type="button" className="btn btn-sm btn-secondary btn-icon" onClick={() => setCoverInvoice(invoice)} aria-label="Reimbursement cover sheet" title="Reimbursement cover sheet"><FileText className="h-4 w-4" aria-hidden /></button> : null}
                          </>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              <div className="scroll-thin hidden overflow-x-auto rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] lg:block">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead className="bg-[var(--color-surface-muted)] text-left text-[0.7rem] uppercase text-[var(--color-ink-faint)]">
                    <tr><th className="px-4 py-3 font-semibold">Invoice</th><th className="px-4 py-3 font-semibold">Individual</th><th className="px-4 py-3 font-semibold">Service period</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 text-right font-semibold">Amount</th><th className="w-24 px-4 py-3"><span className="sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-rule)]">
                    {invoicesForMonth.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="px-4 py-3 font-semibold">{invoice.invoiceNumber}</td>
                        <td className="px-4 py-3"><Link className="hover:text-[var(--color-primary)]" href={`/individuals/${invoice.individualId}?view=classes`}>{invoice.individualName}</Link></td>
                        <td className="tnum whitespace-nowrap px-4 py-3 text-xs">{invoice.servicePeriodStart} - {invoice.servicePeriodEnd}</td>
                        <td className="px-4 py-3"><StatusBadge status={invoice.status} /></td>
                        <td className="tnum px-4 py-3 text-right font-semibold">{formatMoney(invoice.totalAmount)}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            {invoice.status === "draft" && canManage ? (
                              <>
                                <button type="button" className="btn btn-sm btn-ghost btn-icon" disabled={loadingInvoiceId === invoice.id} onClick={() => void editInvoice(invoice)} aria-label="Edit invoice" title="Edit invoice"><Pencil className="h-4 w-4" aria-hidden /></button>
                                <InvoicePdfActions invoice={invoice} canManage={canManage} canEditDocuments={canEditDocuments} subtle />
                                <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" disabled={busyId === invoice.id} onClick={() => setDiscardInvoice(invoice)} aria-label="Discard draft" title="Discard draft"><Trash2 className="h-4 w-4" aria-hidden /></button>
                              </>
                            ) : null}
                            {invoice.status === "issued" ? (
                              <>
                                <InvoicePdfActions invoice={invoice} canManage={canManage} canEditDocuments={canEditDocuments} subtle />
                                {canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => setCoverInvoice(invoice)} aria-label="Reimbursement cover sheet" title="Reimbursement cover sheet"><FileText className="h-4 w-4" aria-hidden /></button> : null}
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {view === "budgets" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <div className="space-y-2 lg:hidden">
              {budgets.map((budget) => (
                <article key={budget.id} className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/individuals/${budget.individualId}?view=classes`} className="block truncate font-semibold hover:text-[var(--color-primary)]">{budget.individualName}</Link>
                      <p className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">{budget.label}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <StatusBadge status={budget.status} />
                      {canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => setBudgetForm(budget)} aria-label="Edit allowance" title="Edit allowance"><Pencil className="h-4 w-4" aria-hidden /></button> : null}
                    </div>
                  </div>
                  <p className="tnum mt-3 border-t border-[var(--color-rule)] pt-3 text-xs text-[var(--color-ink-faint)]">{budget.startDate} - {budget.endDate}</p>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div className="min-w-0"><p className="eyebrow">Authorized</p><p className="tnum mt-1 truncate text-sm font-semibold">{formatMoney(budget.authorizedAmount)}</p></div>
                    <div className="min-w-0 text-right"><p className="eyebrow">Remaining</p><p className={`tnum mt-1 truncate text-sm font-semibold ${dec(budget.remainingAmount).isNegative() ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(budget.remainingAmount)}</p></div>
                    <div className="col-span-2 flex items-center justify-between border-t border-[var(--color-rule)] pt-2 text-sm"><span className="text-[var(--color-ink-soft)]">Issued</span><span className="tnum font-semibold">{formatMoney(budget.consumedAmount)}</span></div>
                  </div>
                </article>
              ))}
              {budgets.length === 0 ? <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-10 text-center text-sm text-[var(--color-ink-faint)]">No class allowances yet.</div> : null}
            </div>
            <div className="hidden overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] lg:block">
              <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead className="bg-[var(--color-surface-muted)] text-left text-[0.7rem] uppercase text-[var(--color-ink-faint)]">
                  <tr><th className="px-4 py-3 font-semibold">Individual</th><th className="px-4 py-3 font-semibold">Period</th><th className="px-4 py-3 font-semibold">Authorized</th><th className="px-4 py-3 font-semibold">Issued</th><th className="px-4 py-3 font-semibold">Remaining</th><th className="px-4 py-3 text-right font-semibold">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-rule)]">
                  {budgets.map((budget) => (
                    <tr key={budget.id}>
                      <td className="px-4 py-3"><Link href={`/individuals/${budget.individualId}?view=classes`} className="font-semibold hover:text-[var(--color-primary)]">{budget.individualName}</Link><p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{budget.label}</p></td>
                      <td className="tnum whitespace-nowrap px-4 py-3 text-xs">{budget.startDate} - {budget.endDate}</td>
                      <td className="tnum px-4 py-3 font-medium">{formatMoney(budget.authorizedAmount)}</td>
                      <td className="tnum px-4 py-3">{formatMoney(budget.consumedAmount)}</td>
                      <td className="tnum px-4 py-3 font-semibold">{formatMoney(budget.remainingAmount)}</td>
                      <td className="px-4 py-3"><div className="flex items-center justify-end gap-2"><StatusBadge status={budget.status} />{canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => setBudgetForm(budget)} aria-label="Edit allowance" title="Edit allowance"><Pencil className="h-4 w-4" aria-hidden /></button> : null}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </div>
          <aside className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
            <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Without an active allowance</h2><span className="badge">{peopleWithoutBudget.length}</span></div>
            <div className="scroll-thin mt-3 max-h-[28rem] space-y-1 overflow-y-auto">
              {peopleWithoutBudget.map((individual) => <div key={individual.id} className="flex items-center justify-between gap-2 border-b border-[var(--color-rule)] py-2 text-sm"><span className="truncate">{individual.label}</span>{canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => { setNewBudgetIndividualId(individual.id); setBudgetForm("new"); }} aria-label={`Add allowance for ${individual.label}`} title="Add allowance"><Plus className="h-4 w-4" aria-hidden /></button> : null}</div>)}
              {peopleWithoutBudget.length === 0 ? <p className="py-8 text-center text-sm text-[var(--color-ink-faint)]">Everyone has an active class allowance.</p> : null}
            </div>
          </aside>
        </div>
      ) : null}

      {view === "activities" ? (
        <div className="overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)]">
          <div className="divide-y divide-[var(--color-rule)] lg:hidden">
            {activities.map((activity) => (
              <article key={activity.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{activity.name}</p>
                    {activity.description ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{activity.description}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <StatusBadge status={activity.isActive ? "active" : "closed"} />
                    {canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => setActivityForm(activity)} aria-label="Edit activity" title="Edit activity"><Settings2 className="h-4 w-4" aria-hidden /></button> : null}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-4 border-t border-[var(--color-rule)] pt-3 text-sm">
                  <span className="tnum text-xs text-[var(--color-ink-soft)]">{activity.code}</span>
                  <span className="tnum font-semibold">{formatMoney(activity.defaultUnitPrice)}</span>
                </div>
              </article>
            ))}
          </div>
          <table className="hidden w-full border-collapse text-sm lg:table">
            <thead className="bg-[var(--color-surface-muted)] text-left text-[0.7rem] uppercase text-[var(--color-ink-faint)]"><tr><th className="px-4 py-3 font-semibold">Activity</th><th className="px-4 py-3 font-semibold">Code</th><th className="px-4 py-3 text-right font-semibold">Default price</th><th className="px-4 py-3 text-right font-semibold">Status</th></tr></thead>
            <tbody className="divide-y divide-[var(--color-rule)]">
              {activities.map((activity) => <tr key={activity.id}><td className="px-4 py-3"><p className="font-semibold">{activity.name}</p>{activity.description ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{activity.description}</p> : null}</td><td className="tnum px-4 py-3 text-xs text-[var(--color-ink-soft)]">{activity.code}</td><td className="tnum px-4 py-3 text-right font-semibold">{formatMoney(activity.defaultUnitPrice)}</td><td className="px-4 py-3"><div className="flex items-center justify-end gap-2"><StatusBadge status={activity.isActive ? "active" : "closed"} />{canManage ? <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => setActivityForm(activity)} aria-label="Edit activity" title="Edit activity"><Settings2 className="h-4 w-4" aria-hidden /></button> : null}</div></td></tr>)}
            </tbody>
          </table>
        </div>
      ) : null}

      {budgetForm ? <BudgetForm individuals={individuals} budget={budgetForm === "new" ? null : budgetForm} initialIndividualId={newBudgetIndividualId} onClose={() => { setBudgetForm(null); setNewBudgetIndividualId(null); }} onSaved={replaceBudget} /> : null}
      {activityForm ? <ActivityForm activity={activityForm === "new" ? null : activityForm} onClose={() => setActivityForm(null)} onSaved={replaceActivity} /> : null}
      {invoiceBudget ? <InvoiceBuilder budget={invoiceBudget} month={month} activities={activities} invoice={editingInvoice} existingInvoiceNumbers={invoices.map((invoice) => invoice.invoiceNumber)} onClose={() => { setInvoiceBudget(null); setEditingInvoice(null); }} onSaved={replaceInvoice} /> : null}
      {issueWarning ? <ReasonDialog title="Issue over annual allowance" warning={`${issueWarning.message} Overage: ${formatMoney(issueWarning.overageAmount)}.`} confirmLabel="Issue invoice" onClose={() => setIssueWarning(null)} onConfirm={(reason) => issue(issueWarning.invoice, reason)} /> : null}
      {voidInvoice ? <ReasonDialog title={`Void ${voidInvoice.invoiceNumber}`} confirmLabel="Void invoice" onClose={() => setVoidInvoice(null)} onConfirm={(reason) => voidIssued(voidInvoice, reason)} /> : null}
      {discardInvoice ? <ConfirmDiscardDialog invoice={discardInvoice} onClose={() => setDiscardInvoice(null)} onConfirm={() => discardDraft(discardInvoice)} /> : null}
      {coverInvoice && canManage ? <ClassCoverSheetDialog invoice={coverInvoice} canManage canEditDocuments={canEditDocuments} onClose={() => setCoverInvoice(null)} /> : null}
    </div>
  );
}

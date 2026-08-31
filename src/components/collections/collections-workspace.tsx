"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { agencyDate } from "@/lib/business/agency-time";
import { useState, type FormEvent } from "react";
import { Archive, CalendarDays, CheckCircle2, Pencil, Plus, ReceiptText, Target } from "lucide-react";
import type {
  CollectionsWorkspaceData,
  DirectPayTargetFinancialRow,
  PayrollCheckRow,
} from "@/lib/data/direct-pay-operations";
import { formatHours, formatMoney } from "@/lib/money";
import { Card, EmptyState, Notice } from "@/components/ui";
import type { CollectionsView, PayrollCheckDraft } from "@/lib/nav/collections-links";

type View = CollectionsView;
type NoticeTone = "success" | "warning" | "error";
type WorkspaceNotice = { tone: NoticeTone; message: string };

interface RequestPayload {
  error?: string;
  message?: string;
  settlementWarning?: string | null;
  data?: { checks?: number; linkedTransactions?: number };
}

async function requestJson(url: string, init: RequestInit): Promise<RequestPayload> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const payload = await response.json().catch(() => ({})) as RequestPayload;
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? "The request could not be completed.");
  return payload;
}

function savedNotice(payload: RequestPayload, successMessage: string): WorkspaceNotice {
  return payload.settlementWarning
    ? { tone: "warning", message: payload.settlementWarning }
    : { tone: "success", message: successMessage };
}

const inputClass = "h-9 w-full rounded-md border border-[var(--color-rule-strong)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-primary)]";
const labelClass = "space-y-1 text-xs font-semibold text-[var(--color-ink-soft)]";

export function payrollCheckRowsHref(check: Pick<PayrollCheckRow,
  "employeeId" | "checkNumber" | "checkDate" | "periodBegin" | "periodEnd">) {
  const params = new URLSearchParams({ view: "rows" });
  params.set("employeeId", check.employeeId);
  if (check.checkNumber) params.set("checkNumber", check.checkNumber);
  if (check.checkDate) {
    params.set("checkDateFrom", check.checkDate);
    params.set("checkDateTo", check.checkDate);
  }
  if (check.periodBegin) params.set("pbFrom", check.periodBegin);
  if (check.periodEnd) params.set("pbTo", check.periodEnd);
  return `/transactions?${params.toString()}`;
}

function SummaryMetric({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "good" | "warn" }) {
  const color = tone === "good" ? "text-[var(--color-success)]" : tone === "warn" ? "text-[var(--color-warn)]" : "text-[var(--color-ink)]";
  return (
    <div className="min-w-0 border-r border-[var(--color-rule)] px-4 py-3 last:border-r-0">
      <p className="text-xs font-semibold text-[var(--color-ink-faint)]">{label}</p>
      <p className={`tnum mt-1 text-lg font-semibold ${color}`}>{formatMoney(value)}</p>
    </div>
  );
}

function TargetForm({
  data,
  initial,
  onDone,
  onCancel,
}: {
  data: CollectionsWorkspaceData;
  initial: DirectPayTargetFinancialRow | null;
  onDone: (notice: WorkspaceNotice) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await requestJson("/api/direct-pay-targets", {
        method: "POST",
        body: JSON.stringify({
          id: initial?.id,
          employeeId: initial?.employeeId ?? form.get("employeeId"),
          intervalUnit: form.get("intervalUnit"),
          intervalCount: form.get("intervalCount"),
          grossTargetAmount: form.get("grossTargetAmount"),
          planningHourlyRate: form.get("planningHourlyRate"),
          effectiveFrom: form.get("effectiveFrom"),
          effectiveTo: form.get("effectiveTo"),
          notes: form.get("notes"),
        }),
      });
      onDone({ tone: "success", message: initial ? "Target updated." : "Target added." });
      router.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : "The target could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3 border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-4">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={labelClass}>Employee
          <select name="employeeId" required defaultValue={initial?.employeeId ?? ""} disabled={Boolean(initial)} className={inputClass}>
            <option value="">Select employee</option>
            {data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </label>
        <label className={labelClass}>Gross target
          <input name="grossTargetAmount" required inputMode="decimal" defaultValue={initial?.grossTargetAmount ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Planning hourly rate
          <input name="planningHourlyRate" required inputMode="decimal" defaultValue={initial?.planningHourlyRate ?? ""} className={inputClass} />
        </label>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <label className={labelClass}>Interval
            <select name="intervalUnit" defaultValue={initial?.intervalUnit ?? "week"} className={inputClass}>
              <option value="week">Week</option><option value="month">Month</option><option value="custom">Custom</option>
            </select>
          </label>
          <label className={labelClass}>Every
            <input name="intervalCount" type="number" min="1" max="52" defaultValue={initial?.intervalCount ?? 1} className={inputClass} />
          </label>
        </div>
        <label className={labelClass}>Effective from
          <input name="effectiveFrom" type="date" required defaultValue={initial?.effectiveFrom ?? agencyDate()} className={inputClass} />
        </label>
        <label className={labelClass}>Effective to
          <input name="effectiveTo" type="date" defaultValue={initial?.effectiveTo ?? ""} className={inputClass} />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>Notes
          <input name="notes" defaultValue={initial?.notes ?? ""} className={inputClass} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button disabled={busy} className="btn btn-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button disabled={busy} className="btn btn-primary" type="submit">{busy ? "Saving..." : initial ? "Update target" : "Add target"}</button>
      </div>
    </form>
  );
}

function PayrollCheckForm({
  data,
  initial,
  draft,
  onDone,
  onCancel,
}: {
  data: CollectionsWorkspaceData;
  initial: PayrollCheckRow | null;
  draft: PayrollCheckDraft | null;
  onDone: (notice: WorkspaceNotice) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const payload = await requestJson("/api/payroll-checks", {
        method: "POST",
        body: JSON.stringify({
          id: initial?.id,
          employeeId: initial?.employeeId ?? form.get("employeeId"),
          checkNumber: form.get("checkNumber"),
          checkDate: form.get("checkDate"),
          periodBegin: form.get("periodBegin"),
          periodEnd: form.get("periodEnd"),
          actualGross: form.get("actualGross"),
          actualNet: form.get("actualNet"),
          taxWithheld: form.get("taxWithheld"),
          sourceRef: form.get("sourceRef"),
          verificationStatus: form.get("verificationStatus"),
          notes: form.get("notes"),
          sourceTransactionIds: draft?.sourceTransactionIds ?? [],
        }),
      });
      onDone(savedNotice(payload, initial ? "Payroll check updated." : "Payroll check added."));
      router.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : "The payroll check could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3 border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-4">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={labelClass}>Employee
          <select name="employeeId" required defaultValue={initial?.employeeId ?? draft?.employeeId ?? ""} disabled={Boolean(initial)} className={inputClass}>
            <option value="">Select employee</option>
            {data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </label>
        <label className={labelClass}>Check number
          <input name="checkNumber" defaultValue={initial?.checkNumber ?? draft?.checkNumber ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Check date
          <input name="checkDate" type="date" defaultValue={initial?.checkDate ?? draft?.checkDate ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Status
          <select name="verificationStatus" defaultValue={initial?.verificationStatus ?? "verified"} className={inputClass}>
            <option value="verified">Verified</option><option value="unverified">Unverified</option><option value="void">Void</option>
          </select>
        </label>
        <label className={labelClass}>Period begin
          <input name="periodBegin" type="date" defaultValue={initial?.periodBegin ?? draft?.periodBegin ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Period end
          <input name="periodEnd" type="date" defaultValue={initial?.periodEnd ?? draft?.periodEnd ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Actual gross
          <input name="actualGross" inputMode="decimal" defaultValue={initial?.actualGross ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Actual net
          <input name="actualNet" required inputMode="decimal" defaultValue={initial?.actualNet ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Tax / withholding
          <input name="taxWithheld" inputMode="decimal" defaultValue={initial?.taxWithheld ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>Source reference
          <input name="sourceRef" defaultValue={initial?.sourceRef ?? ""} className={inputClass} />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>Notes
          <input name="notes" defaultValue={initial?.notes ?? ""} className={inputClass} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button disabled={busy} className="btn btn-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button disabled={busy} className="btn btn-primary" type="submit">{busy ? "Saving..." : initial ? "Update check" : "Add check"}</button>
      </div>
    </form>
  );
}

export default function CollectionsWorkspace({
  data,
  canManage,
  canManageEmployeeDeals,
  canRepairImports,
  initialView = "summary",
  initialCheckDraft = null,
}: {
  data: CollectionsWorkspaceData;
  canManage: boolean;
  canManageEmployeeDeals: boolean;
  canRepairImports: boolean;
  initialView?: View;
  initialCheckDraft?: PayrollCheckDraft | null;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>(initialView);
  const [editingTarget, setEditingTarget] = useState<DirectPayTargetFinancialRow | null>(null);
  const [editingCheck, setEditingCheck] = useState<PayrollCheckRow | null>(null);
  const [creatingTarget, setCreatingTarget] = useState(false);
  const [creatingCheck, setCreatingCheck] = useState(Boolean(initialCheckDraft));
  const [verifyingCheckId, setVerifyingCheckId] = useState<string | null>(null);
  const [repairingImports, setRepairingImports] = useState(false);
  const [checkDraft, setCheckDraft] = useState<PayrollCheckDraft | null>(initialCheckDraft);
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const canManageTargets = canManage && data.visibility.canSeeTargetMoney;
  const canManageChecks = canManage && data.visibility.canSeeCheckNet && data.visibility.canSeeTaxes;
  const checksToReview = data.payrollChecks.filter((check) => check.verificationStatus === "unverified");
  const targetGrid = data.visibility.canSeeTargetMoney && data.visibility.canSeeTargetHours
    ? "sm:grid-cols-[minmax(10rem,1fr)_repeat(3,minmax(7rem,auto))_auto]"
    : "sm:grid-cols-[minmax(10rem,1fr)_repeat(2,minmax(7rem,auto))_auto]";
  const tabs: Array<{ id: View; label: string; icon: typeof Target }> = [
    { id: "summary", label: "Monthly report", icon: CalendarDays },
    ...(data.visibility.canSeeTargetMoney || data.visibility.canSeeTargetHours
      ? [{ id: "targets" as const, label: "Direct-pay targets", icon: Target }]
      : []),
    ...(data.visibility.canSeeCheckNet || data.visibility.canSeeTaxes
      ? [{ id: "checks" as const, label: "Payroll checks", icon: ReceiptText }]
      : []),
  ];
  async function archiveTarget(id: string) {
    if (!window.confirm("Archive this target?")) return;
    try {
      await requestJson(`/api/direct-pay-targets/${id}`, { method: "DELETE" });
      setNotice({ tone: "success", message: "Target archived." });
      router.refresh();
    } catch (value) {
      setNotice({
        tone: "error",
        message: value instanceof Error ? value.message : "The target could not be archived.",
      });
    }
  }
  async function verifyCheck(check: PayrollCheckRow) {
    if (!check.actualNet || verifyingCheckId) return;
    setVerifyingCheckId(check.id);
    setNotice(null);
    try {
      const payload = await requestJson("/api/payroll-checks", {
        method: "POST",
        body: JSON.stringify({
          id: check.id,
          employeeId: check.employeeId,
          checkNumber: check.checkNumber,
          checkDate: check.checkDate,
          periodBegin: check.periodBegin,
          periodEnd: check.periodEnd,
          actualGross: check.actualGross,
          actualNet: check.actualNet,
          taxWithheld: check.taxWithheld,
          sourceRef: check.sourceRef,
          verificationStatus: "verified",
          notes: check.notes,
        }),
      });
      setNotice(savedNotice(payload, "Check verified and collection amount calculated."));
      router.refresh();
    } catch (value) {
      setNotice({
        tone: "error",
        message: value instanceof Error ? value.message : "The check could not be verified.",
      });
    } finally {
      setVerifyingCheckId(null);
    }
  }
  async function repairImportedChecks() {
    if (repairingImports) return;
    setRepairingImports(true);
    setNotice(null);
    try {
      const payload = await requestJson("/api/payroll-checks/import-reviews", { method: "POST" });
      const checks = payload.data?.checks ?? 0;
      const linked = payload.data?.linkedTransactions ?? 0;
      setNotice(savedNotice(
        payload,
        checks > 0 || linked > 0
          ? `Found ${checks.toLocaleString()} imported ${checks === 1 ? "check" : "checks"} and linked ${linked.toLocaleString()} source ${linked === 1 ? "row" : "rows"}.`
          : "Imported checks are already up to date.",
      ));
      router.refresh();
    } catch (value) {
      setNotice({
        tone: "error",
        message: value instanceof Error ? value.message : "Imported checks could not be reviewed.",
      });
    } finally {
      setRepairingImports(false);
    }
  }
  function selectView(nextView: View) {
    setView(nextView);
    setCreatingTarget(false);
    setCreatingCheck(false);
    setCheckDraft(null);
    setEditingTarget(null);
    setEditingCheck(null);
  }
  function handleTabKey(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? [],
    );
    const current = buttons.indexOf(event.currentTarget);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    buttons[next]?.click();
  }
  return (
    <div className="space-y-4">
      {checksToReview.length > 0 ? (
        <Notice
          tone="warning"
          action={(
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => selectView("checks")}>
              Review checks
            </button>
          )}
        >
          {checksToReview.length.toLocaleString()} imported {checksToReview.length === 1 ? "check needs" : "checks need"} confirmation. No employee collection is created until the whole-check net is verified.
        </Notice>
      ) : null}
      <div className="overflow-x-auto border-y border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
        <div className="grid min-w-[760px] grid-cols-5">
          <SummaryMetric label="Give-backs from checks" value={data.summary.dueFromChecks} />
          <SummaryMetric label="Collected this month" value={data.summary.collectedThisMonth} tone="good" />
          <SummaryMetric label="Employee balance" value={data.summary.remainingReceivable} tone="warn" />
          <SummaryMetric label="Set-aside plan" value={data.summary.plannedSetAside} />
          <SummaryMetric label="Set aside this month" value={data.summary.setAsideThisMonth} tone="good" />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule-strong)]">
        <div className="flex max-w-full gap-1 overflow-x-auto" role="tablist" aria-label="Collections views">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return <button key={tab.id} id={`collections-tab-${tab.id}`} aria-controls={`collections-panel-${tab.id}`} type="button" role="tab" aria-selected={view === tab.id} tabIndex={view === tab.id ? 0 : -1} onKeyDown={handleTabKey} onClick={() => selectView(tab.id)} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${view === tab.id ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)]"}`}><Icon size={15} aria-hidden />{tab.label}</button>;
          })}
        </div>
        {view === "summary" ? (
          <form className="flex items-center gap-2 pb-2" action="/masser" method="get">
            <label className="text-xs font-semibold text-[var(--color-ink-soft)]" htmlFor="collections-month">Month</label>
            <input id="collections-month" name="month" type="month" defaultValue={data.month} className={inputClass} />
            <button className="btn btn-secondary" type="submit">Apply</button>
          </form>
        ) : null}
      </div>

      {notice ? <Notice tone={notice.tone} action={<button type="button" onClick={() => setNotice(null)} className="text-xs font-semibold">Dismiss</button>}>{notice.message}</Notice> : null}

      {view === "summary" ? (
        <div id="collections-panel-summary" role="tabpanel" aria-labelledby="collections-tab-summary" className="grid gap-4 xl:grid-cols-2">
          <Card title="Employee receivables" description={`Check obligations and collection position for ${data.month}.`}>
            {data.employeeCollections.length === 0 ? <EmptyState compact title="No employee collection activity" /> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-soft)]"><tr><th className="px-4 py-2.5 text-left">Employee</th><th className="px-3 py-2.5 text-right">Due</th><th className="px-3 py-2.5 text-right">Collected</th><th className="px-3 py-2.5 text-right">Remaining</th><th className="px-3 py-2.5 text-right">Credit</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead><tbody className="divide-y divide-[var(--color-rule)]">{data.employeeCollections.map((row) => <tr key={row.employeeId}><td className="px-4 py-3"><p className="font-medium">{row.employeeName}</p><Link className="text-xs font-medium text-[var(--color-primary)] hover:underline" href={`/employees/${row.employeeId}?view=deal`}>{canManageEmployeeDeals ? "View or change deal" : "View deal"}</Link>{!canManageEmployeeDeals ? <span className="ml-1 text-xs text-[var(--color-ink-faint)]">(manager changes)</span> : null}</td><td className="tnum px-3 py-3 text-right">{formatMoney(row.dueFromChecks)}</td><td className="tnum px-3 py-3 text-right text-[var(--color-success)]">{formatMoney(row.collectedThisMonth)}</td><td className="tnum px-3 py-3 text-right font-semibold">{formatMoney(row.remainingReceivable)}</td><td className="tnum px-3 py-3 text-right">{formatMoney(row.availableCredit)}</td><td className="px-3 py-3 text-right"><Link className="btn btn-sm btn-ghost whitespace-nowrap" href={`/settlements?employeeId=${row.employeeId}&queue=receivable`}>Record collection</Link></td></tr>)}</tbody></table></div>
            )}
          </Card>
          <Card title="Individual set-asides" description={`Month-end position for ${data.month}, using each individual's plan active on the final calendar day.`}>
            {data.individualSetAsides.length === 0 ? <EmptyState compact title="No individual set-aside activity" /> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-soft)]"><tr><th className="px-4 py-2.5 text-left">Individual</th><th className="px-3 py-2.5 text-right">Plan</th><th className="px-3 py-2.5 text-right">Set aside</th><th className="px-3 py-2.5 text-right">Remaining</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead><tbody className="divide-y divide-[var(--color-rule)]">{data.individualSetAsides.map((row) => <tr key={row.individualId}><td className="px-4 py-3 font-medium">{row.individualName}</td><td className="tnum px-3 py-3 text-right">{formatMoney(row.plannedThisMonth)}</td><td className="tnum px-3 py-3 text-right text-[var(--color-success)]">{formatMoney(row.setAsideThisMonth)}</td><td className="tnum px-3 py-3 text-right font-semibold">{formatMoney(row.remainingSetAside)}</td><td className="px-3 py-3"><div className="flex justify-end gap-1">{canManage ? <Link className="btn btn-sm btn-secondary whitespace-nowrap" href={`/settlements?individualId=${row.individualId}&queue=reserve`}>Record set-aside</Link> : null}<Link className="btn btn-sm btn-ghost whitespace-nowrap" href={`/masser/individuals/${row.individualId}?month=${data.month}`}>View statement</Link></div></td></tr>)}</tbody></table></div>
            )}
          </Card>
        </div>
      ) : view === "targets" ? (
        <div id="collections-panel-targets" role="tabpanel" aria-labelledby="collections-tab-targets">
        <Card title="Employee direct-pay targets" action={canManageTargets ? <button type="button" className="btn btn-secondary" onClick={() => { setEditingTarget(null); setCreatingTarget(true); }}><Plus size={15} aria-hidden /> Add target</button> : null}>
          {canManageTargets && (creatingTarget || editingTarget) ? <TargetForm key={editingTarget?.id ?? "new-target"} data={data} initial={editingTarget} onCancel={() => { setCreatingTarget(false); setEditingTarget(null); }} onDone={(nextNotice) => { setNotice(nextNotice); setCreatingTarget(false); setEditingTarget(null); }} /> : null}
          {data.targets.length === 0 ? <EmptyState compact title="No direct-pay targets configured" /> : <div className="divide-y divide-[var(--color-rule)]">{data.targets.map((row) => <div key={row.id} className={`grid gap-3 px-4 py-3 sm:items-center ${targetGrid}`}><div><p className="font-semibold">{row.employeeName}</p><p className="text-xs text-[var(--color-ink-faint)]">{row.effectiveFrom}{row.effectiveTo ? ` to ${row.effectiveTo}` : " onward"}</p></div>{data.visibility.canSeeTargetMoney ? <div className="text-sm"><span className="text-[var(--color-ink-faint)]">Gross </span><span className="tnum font-semibold">{row.grossTargetAmount ? formatMoney(row.grossTargetAmount) : "-"}</span></div> : null}<div className="text-sm"><span className="text-[var(--color-ink-faint)]">Every </span>{row.intervalCount > 1 ? `${row.intervalCount} ` : ""}{row.intervalUnit}{row.intervalCount > 1 ? "s" : ""}</div>{data.visibility.canSeeTargetHours ? <div className="text-sm"><span className="text-[var(--color-ink-faint)]">Target </span><span className="tnum font-semibold">{row.targetHours ? `${formatHours(row.targetHours)} h` : "-"}</span></div> : null}<div className="flex justify-end gap-1">{row.status === "active" && canManageTargets ? <><button type="button" title="Edit target" onClick={() => setEditingTarget(row)} className="icon-button"><Pencil size={15} aria-hidden /></button><button type="button" title="Archive target" onClick={() => void archiveTarget(row.id)} className="icon-button"><Archive size={15} aria-hidden /></button></> : <span className="text-xs text-[var(--color-ink-faint)]">{row.status === "archived" ? "Archived" : "Read only"}</span>}</div></div>)}</div>}
        </Card>
        </div>
      ) : (
        <div id="collections-panel-checks" role="tabpanel" aria-labelledby="collections-tab-checks">
        <Card title="Actual payroll checks" action={canManageChecks ? <div className="flex flex-wrap gap-2">{canRepairImports ? <button type="button" disabled={repairingImports} className="btn btn-secondary" onClick={() => void repairImportedChecks()}>{repairingImports ? "Checking..." : "Find imported checks"}</button> : null}<button type="button" className="btn btn-secondary" onClick={() => { setEditingCheck(null); setCheckDraft(null); setCreatingCheck(true); }}><Plus size={15} aria-hidden /> Add check</button></div> : null}>
          {canManageChecks && (creatingCheck || editingCheck) ? <PayrollCheckForm key={editingCheck?.id ?? `new-check:${checkDraft?.employeeId ?? "blank"}:${checkDraft?.sourceTransactionIds.join(",") ?? "manual"}`} data={data} initial={editingCheck} draft={editingCheck ? null : checkDraft} onCancel={() => { setCreatingCheck(false); setEditingCheck(null); setCheckDraft(null); }} onDone={(nextNotice) => { setNotice(nextNotice); setCreatingCheck(false); setEditingCheck(null); setCheckDraft(null); }} /> : null}
          {data.payrollChecks.length === 0 ? <EmptyState compact title="No payroll checks recorded" /> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-soft)]"><tr><th className="px-4 py-2.5 text-left">Employee / check</th><th className="px-3 py-2.5">Date</th>{data.visibility.canSeeTaxes ? <th className="px-3 py-2.5 text-right">Gross</th> : null}{data.visibility.canSeeCheckNet ? <th className="px-3 py-2.5 text-right">Net</th> : null}{data.visibility.canSeeTaxes ? <th className="px-3 py-2.5 text-right">Tax</th> : null}<th className="px-3 py-2.5 text-right">Source</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead><tbody className="divide-y divide-[var(--color-rule)]">{data.payrollChecks.map((row) => <tr key={row.id} className={row.verificationStatus === "unverified" ? "bg-[var(--color-warn-soft)]" : undefined}><td className="px-4 py-3"><p className="font-medium">{row.employeeName}</p><p className="text-xs text-[var(--color-ink-faint)]">{row.checkNumber || "No check number"}</p></td><td className="px-3 py-3">{row.checkDate ?? row.periodEnd ?? row.periodBegin ?? "-"}</td>{data.visibility.canSeeTaxes ? <td className="tnum px-3 py-3 text-right">{row.actualGross ? formatMoney(row.actualGross) : "-"}</td> : null}{data.visibility.canSeeCheckNet ? <td className="tnum px-3 py-3 text-right font-semibold">{row.actualNet ? formatMoney(row.actualNet) : "-"}</td> : null}{data.visibility.canSeeTaxes ? <td className="tnum px-3 py-3 text-right">{row.taxWithheld ? formatMoney(row.taxWithheld) : "-"}</td> : null}<td className="tnum px-3 py-3 text-right">{row.transactionIds.length > 0 ? <Link href={payrollCheckRowsHref(row)} className="font-semibold text-[var(--color-primary)] hover:underline">{row.linkedTransactions} {row.linkedTransactions === 1 ? "row" : "rows"}</Link> : "-"}</td><td className="px-3 py-3"><span className={`inline-flex items-center gap-1 text-xs font-semibold ${row.verificationStatus === "verified" ? "text-[var(--color-success)]" : "text-[var(--color-warn)]"}`}>{row.verificationStatus === "verified" ? <CheckCircle2 size={13} aria-hidden /> : null}{row.verificationStatus === "unverified" ? "Needs review" : row.verificationStatus}</span></td><td className="px-3 py-3 text-right">{canManageChecks ? <div className="flex justify-end gap-1">{row.verificationStatus === "unverified" ? <button type="button" disabled={verifyingCheckId !== null} onClick={() => void verifyCheck(row)} className="btn btn-sm btn-primary whitespace-nowrap">{verifyingCheckId === row.id ? "Verifying..." : "Verify & calculate"}</button> : null}<button type="button" title="Edit payroll check" onClick={() => { setCheckDraft(null); setCreatingCheck(false); setEditingCheck(row); }} className="icon-button"><Pencil size={15} aria-hidden /></button></div> : null}</td></tr>)}</tbody></table></div>}
        </Card>
        </div>
      )}
    </div>
  );
}

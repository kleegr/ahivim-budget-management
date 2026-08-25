"use client";

import { useMemo, useState } from "react";
import {
  CalendarPlus,
  CircleAlert,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { ModalShell } from "@/components/schedule/shared";
import {
  generateClassDatesBetween,
  onOrAfterNonSaturday,
} from "@/lib/business/class-invoicing";
import type {
  ClassActivityRecord,
  ClassBudgetRecord,
  ClassInvoiceRecord,
} from "@/lib/data/class-invoices";
import { dec, formatMoney } from "@/lib/money";

interface EditableLine {
  key: string;
  activityId: string;
  serviceDate: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
}

interface ApiFailureDetails {
  kind?: string;
  authorizedAmount?: string;
  consumedAmount?: string;
  invoiceAmount?: string;
  projectedAmount?: string;
  overageAmount?: string;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  details?: ApiFailureDetails;
}

export async function classRequest<T>(
  url: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json().catch(() => ({}))) as ApiResult<T>;
    if (!response.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error ?? `Request failed (${response.status}).`,
        details: json.details,
      };
    }
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

function monthEnd(month: string): string {
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, part!, 0)).toISOString().slice(0, 10);
}

function nextMonthStart(month: string): string {
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, part!, 1)).toISOString().slice(0, 10);
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function suggestedInvoiceNumber(month: string, budgetId: string, existing: readonly string[]): string {
  const base = `CLS-${month.replace("-", "")}-${budgetId.slice(0, 4).toUpperCase()}`;
  const used = new Set(existing.map((value) => value.toUpperCase()));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function makeLine(
  date: string,
  activity: ClassActivityRecord | undefined,
  index: number,
): EditableLine {
  return {
    key: `${date}-${index}-${crypto.randomUUID()}`,
    activityId: activity?.id ?? "",
    serviceDate: date,
    description: activity?.name ?? "",
    quantity: "1",
    unitPrice: activity?.defaultUnitPrice ?? "150.0000",
    discountAmount: "0",
  };
}

function draftLines(
  month: string,
  budget: ClassBudgetRecord,
  activities: ClassActivityRecord[],
): EditableLine[] {
  const first = `${month}-01`;
  const start = maxDate(first, budget.startDate);
  const end = minDate(monthEnd(month), budget.endDate);
  const defaultActivity = activities.find((activity) => activity.isActive);
  return generateClassDatesBetween(start, end)
    .map((date, index) => makeLine(date, defaultActivity, index));
}

function lineTotal(line: EditableLine) {
  try {
    return dec(line.quantity || 0)
      .times(dec(line.unitPrice || 0))
      .minus(dec(line.discountAmount || 0));
  } catch {
    return dec(0);
  }
}

function MobileLineCard({
  line,
  index,
  activities,
  onActivity,
  onUpdate,
  onRemove,
}: {
  line: EditableLine;
  index: number;
  activities: ClassActivityRecord[];
  onActivity: (activityId: string) => void;
  onUpdate: (patch: Partial<EditableLine>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Date {index + 1}</span>
        <div className="flex items-center gap-2">
          <span className="tnum text-sm font-semibold">{formatMoney(lineTotal(line).toString())}</span>
          <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" onClick={onRemove} aria-label={`Remove date ${index + 1}`} title="Remove date">
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="col-span-2 text-xs font-semibold text-[var(--color-ink-soft)]">
          Service date
          <input className="input mt-1 w-full" type="date" value={line.serviceDate} onChange={(event) => onUpdate({ serviceDate: event.target.value })} />
        </label>
        <label className="col-span-2 text-xs font-semibold text-[var(--color-ink-soft)]">
          Activity
          <select className="select mt-1 w-full" value={line.activityId} onChange={(event) => onActivity(event.target.value)}>
            <option value="">Custom</option>
            {activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.name}</option>)}
          </select>
        </label>
        {!line.activityId ? (
          <label className="col-span-2 text-xs font-semibold text-[var(--color-ink-soft)]">
            Description
            <input className="input mt-1 w-full" value={line.description} onChange={(event) => onUpdate({ description: event.target.value })} />
          </label>
        ) : null}
        <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
          Quantity
          <input className="input tnum mt-1 w-full" inputMode="decimal" value={line.quantity} onChange={(event) => onUpdate({ quantity: event.target.value })} />
        </label>
        <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
          Rate
          <input className="input tnum mt-1 w-full" inputMode="decimal" value={line.unitPrice} onChange={(event) => onUpdate({ unitPrice: event.target.value })} />
        </label>
        <label className="col-span-2 text-xs font-semibold text-[var(--color-ink-soft)]">
          Discount
          <input className="input tnum mt-1 w-full" inputMode="decimal" value={line.discountAmount} onChange={(event) => onUpdate({ discountAmount: event.target.value })} />
        </label>
      </div>
    </div>
  );
}

export default function InvoiceBuilder({
  budget,
  month,
  activities,
  invoice,
  existingInvoiceNumbers = [],
  onClose,
  onSaved,
}: {
  budget: ClassBudgetRecord;
  month: string;
  activities: ClassActivityRecord[];
  invoice?: ClassInvoiceRecord | null;
  existingInvoiceNumbers?: string[];
  onClose: () => void;
  onSaved: (invoice: ClassInvoiceRecord) => void;
}) {
  const activeActivities = useMemo(
    () => activities.filter((activity) => activity.isActive),
    [activities],
  );
  const serviceStart = maxDate(`${month}-01`, budget.startDate);
  const serviceEnd = minDate(monthEnd(month), budget.endDate);
  const [invoiceNumber, setInvoiceNumber] = useState(
    invoice?.invoiceNumber ?? suggestedInvoiceNumber(month, budget.id, existingInvoiceNumbers),
  );
  const [invoiceDate, setInvoiceDate] = useState(
    invoice?.invoiceDate ?? onOrAfterNonSaturday(nextMonthStart(month)),
  );
  const [billToName, setBillToName] = useState(invoice?.billToName ?? budget.individualName);
  const [address1, setAddress1] = useState(invoice?.billToAddressLine1 ?? "");
  const [address2, setAddress2] = useState(invoice?.billToAddressLine2 ?? "");
  const [cityStateZip, setCityStateZip] = useState(invoice?.billToCityStateZip ?? "");
  const [purpose, setPurpose] = useState(invoice?.purpose ?? "CLASSES");
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const [lines, setLines] = useState<EditableLine[]>(() => (
    invoice
      ? invoice.lines.map((line, index) => ({
          key: line.id || `${line.serviceDate}-${index}`,
          activityId: line.activityId ?? "",
          serviceDate: line.serviceDate,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
        }))
      : draftLines(month, budget, activeActivities)
  ));
  const [bulkActivity, setBulkActivity] = useState(activeActivities[0]?.id ?? "");
  const [bulkRate, setBulkRate] = useState(activeActivities[0]?.defaultUnitPrice ?? "150");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = useMemo(
    () => lines.reduce((sum, line) => sum.plus(lineTotal(line)), dec(0)),
    [lines],
  );
  const remainingAfter = useMemo(
    () => dec(budget.remainingAmount).minus(total),
    [budget.remainingAmount, total],
  );

  const updateLine = (key: string, patch: Partial<EditableLine>) => {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  };

  const chooseActivity = (key: string, activityId: string) => {
    const activity = activeActivities.find((item) => item.id === activityId);
    updateLine(key, {
      activityId,
      description: activity?.name ?? "",
      unitPrice: activity?.defaultUnitPrice ?? "150",
    });
  };

  const regenerate = () => {
    setLines(draftLines(month, budget, activeActivities));
    setError(null);
  };

  const applyActivity = () => {
    const activity = activeActivities.find((item) => item.id === bulkActivity);
    if (!activity) return;
    setLines((current) => current.map((line) => ({
      ...line,
      activityId: activity.id,
      description: activity.name,
      unitPrice: activity.defaultUnitPrice,
    })));
  };

  const applyRate = () => {
    setLines((current) => current.map((line) => ({ ...line, unitPrice: bulkRate })));
  };

  const save = async () => {
    setError(null);
    if (!invoiceNumber.trim()) {
      setError("Enter an invoice number.");
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one class date.");
      return;
    }
    if (lines.some((line) => !line.activityId && !line.description.trim())) {
      setError("Every class date needs an activity or description.");
      return;
    }

    setSaving(true);
    const body = {
      classBudgetPeriodId: budget.id,
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      servicePeriodStart: serviceStart,
      servicePeriodEnd: serviceEnd,
      billToName: billToName.trim(),
      billToAddressLine1: address1.trim() || null,
      billToAddressLine2: address2.trim() || null,
      billToCityStateZip: cityStateZip.trim() || null,
      purpose: purpose.trim() || "CLASSES",
      notes: notes.trim() || null,
      lines: lines.map((line, index) => ({
        activityId: line.activityId || null,
        serviceDate: line.serviceDate,
        description: line.description.trim(),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
        sortOrder: index,
      })),
    };
    const result = await classRequest<ClassInvoiceRecord>(
      invoice ? `/api/classes/invoices/${invoice.id}` : "/api/classes/invoices",
      invoice ? "PATCH" : "POST",
      body,
    );
    setSaving(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not save the invoice draft.");
      return;
    }
    onSaved(result.data);
  };

  return (
    <ModalShell
      title={invoice ? `Invoice ${invoice.invoiceNumber}` : `New invoice - ${budget.individualName}`}
      onClose={onClose}
      workspace
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Invoice number
            <input className="input mt-1 w-full" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Invoice date
            <input className="input mt-1 w-full" type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Service from
            <input className="input mt-1 w-full" type="date" value={serviceStart} disabled />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Service through
            <input className="input mt-1 w-full" type="date" value={serviceEnd} disabled />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Bill to
            <input className="input mt-1 w-full" value={billToName} onChange={(event) => setBillToName(event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Purpose
            <input className="input mt-1 w-full" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Address line 1
            <input className="input mt-1 w-full" value={address1} onChange={(event) => setAddress1(event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Address line 2
            <input className="input mt-1 w-full" value={address2} onChange={(event) => setAddress2(event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)] sm:col-span-2">
            City, state and ZIP
            <input className="input mt-1 w-full" value={cityStateZip} onChange={(event) => setCityStateZip(event.target.value)} />
          </label>
        </div>

        <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-3">
          <div className="flex flex-wrap items-end gap-2">
            <button type="button" className="btn btn-sm btn-secondary" onClick={regenerate}>
              <CalendarPlus className="h-4 w-4" aria-hidden />
              22 dates
            </button>
            <label className="min-w-44 flex-1 text-xs font-semibold text-[var(--color-ink-soft)]">
              Activity for all
              <select className="select mt-1 w-full" value={bulkActivity} onChange={(event) => setBulkActivity(event.target.value)}>
                {activeActivities.map((activity) => <option key={activity.id} value={activity.id}>{activity.name}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-sm btn-secondary" onClick={applyActivity}>Apply</button>
            <label className="w-28 text-xs font-semibold text-[var(--color-ink-soft)]">
              Rate for all
              <input className="input mt-1 w-full" inputMode="decimal" value={bulkRate} onChange={(event) => setBulkRate(event.target.value)} />
            </label>
            <button type="button" className="btn btn-sm btn-secondary" onClick={applyRate}>Apply</button>
          </div>
        </div>

        <div className="scroll-thin max-h-[48vh] space-y-2 overflow-y-auto md:hidden">
          {lines.map((line, index) => (
            <MobileLineCard
              key={line.key}
              line={line}
              index={index}
              activities={activeActivities}
              onActivity={(activityId) => chooseActivity(line.key, activityId)}
              onUpdate={(patch) => updateLine(line.key, patch)}
              onRemove={() => setLines((current) => current.filter((item) => item.key !== line.key))}
            />
          ))}
        </div>

        <div className="scroll-thin hidden max-h-[34vh] overflow-auto rounded-md border border-[var(--color-rule)] md:block">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--color-surface-muted)] text-left text-[0.7rem] uppercase text-[var(--color-ink-faint)]">
              <tr>
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Activity</th>
                <th className="px-3 py-2 font-semibold">Qty</th>
                <th className="px-3 py-2 font-semibold">Rate</th>
                <th className="px-3 py-2 font-semibold">Discount</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="w-12 px-2 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-rule)]">
              {lines.map((line) => (
                <tr key={line.key}>
                  <td className="px-2 py-1.5"><input aria-label="Service date" className="input h-9 w-36" type="date" value={line.serviceDate} onChange={(event) => updateLine(line.key, { serviceDate: event.target.value })} /></td>
                  <td className="px-2 py-1.5">
                    <select aria-label="Activity" className="select h-9 min-w-48" value={line.activityId} onChange={(event) => chooseActivity(line.key, event.target.value)}>
                      <option value="">Custom</option>
                      {activeActivities.map((activity) => <option key={activity.id} value={activity.id}>{activity.name}</option>)}
                    </select>
                    {!line.activityId ? <input aria-label="Description" className="input mt-1 h-9 w-full" value={line.description} onChange={(event) => updateLine(line.key, { description: event.target.value })} /> : null}
                  </td>
                  <td className="px-2 py-1.5"><input aria-label="Quantity" className="input tnum h-9 w-20" inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} /></td>
                  <td className="px-2 py-1.5"><input aria-label="Unit price" className="input tnum h-9 w-24" inputMode="decimal" value={line.unitPrice} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} /></td>
                  <td className="px-2 py-1.5"><input aria-label="Discount" className="input tnum h-9 w-24" inputMode="decimal" value={line.discountAmount} onChange={(event) => updateLine(line.key, { discountAmount: event.target.value })} /></td>
                  <td className="tnum whitespace-nowrap px-3 py-2 text-right font-semibold">{formatMoney(lineTotal(line).toString())}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))} aria-label="Remove line" title="Remove line">
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => setLines((current) => [...current, makeLine(serviceStart, activeActivities[0], current.length)])}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add date
        </button>

        <div className="grid gap-3 rounded-md border border-[var(--color-rule)] p-4 sm:grid-cols-3">
          <div>
            <p className="eyebrow">Annual allowance left</p>
            <p className="tnum mt-1 text-lg font-semibold">{formatMoney(budget.remainingAmount)}</p>
          </div>
          <div>
            <p className="eyebrow">This invoice</p>
            <p className="tnum mt-1 text-lg font-semibold">{formatMoney(total.toString())}</p>
          </div>
          <div>
            <p className="eyebrow">Left after issue</p>
            <p className={`tnum mt-1 text-lg font-semibold ${remainingAfter.isNegative() ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(remainingAfter.toString())}</p>
          </div>
        </div>

        {remainingAfter.isNegative() ? (
          <div className="flex gap-2 rounded-md border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn)]">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            This draft would exceed the annual class allowance by {formatMoney(remainingAfter.abs().toString())}.
          </div>
        ) : null}

        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
          Internal note
          <textarea className="input mt-1 min-h-20 w-full py-2" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>

        {error ? <p className="text-sm font-medium text-[var(--color-danger)]" role="alert">{error}</p> : null}

        <div className="sticky bottom-0 z-20 -mx-5 flex flex-wrap justify-end gap-2 border-t border-[var(--color-rule)] bg-[var(--color-surface)] px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:px-0 sm:pb-0">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            <Save className="h-4 w-4" aria-hidden />
            {saving ? "Saving..." : "Save draft"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

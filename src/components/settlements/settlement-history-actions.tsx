"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Modal } from "@/components/manage/client";
import type { SettlementEventRow, SettlementRow } from "@/lib/data/settlements";
import { dec, formatMoney, type Decimal } from "@/lib/money";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ApiPayload<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}
async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as ApiPayload<T>;
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error ?? `Request failed (${response.status}).`);
    }
    return payload.data as T;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Could not reach the server. Nothing was recorded.");
  }
}

function localToday(): string {
  const today = new Date();
  const year = String(today.getFullYear());
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}

function eventItemIdentity(event: Pick<
  SettlementEventRow,
  "checkNumber" | "checkDate" | "periodBegin" | "periodEnd"
>): string {
  const period = event.periodBegin && event.periodEnd
    ? `${formatDate(event.periodBegin)} to ${formatDate(event.periodEnd)}`
    : event.periodEnd
      ? `Through ${formatDate(event.periodEnd)}`
      : event.periodBegin
        ? `From ${formatDate(event.periodBegin)}`
        : event.checkDate
          ? formatDate(event.checkDate)
          : null;
  if (event.checkNumber) return `Check ${event.checkNumber}${period ? ` | ${period}` : ""}`;
  if (period) return period;
  return "Ledger item";
}

function rowDate(row: SettlementRow): string {
  return row.checkDate ?? row.periodEnd ?? row.periodBegin ?? row.createdAt.slice(0, 10);
}

function parsePositiveAmount(value: string): Decimal | null {
  try {
    const amount = dec(value.trim()).toDecimalPlaces(4);
    return amount.greaterThan(0) ? amount : null;
  } catch {
    return null;
  }
}

function personHref(personType: SettlementRow["personType"], personId: string): string {
  return personType === "employee" ? `/employees/${personId}` : `/individuals/${personId}`;
}

function eventLabel(event: SettlementEventRow): string {
  if (event.eventType === "reversal") return "Reversal";
  if (event.batchAction === "correct_event") {
    return event.eventType === "set_aside" ? "Corrected set-aside" : "Corrected payment";
  }
  if (event.eventType === "set_aside") return "Set aside";
  if (event.eventType === "credit") return dec(event.amount).isNegative() ? "Credit used" : "Credit applied";
  if (event.eventType === "adjustment") {
    return event.batchAction === "refund_credit" ? "Credit refunded / released" : "Adjustment";
  }
  return "Payment";
}

export function HistoryTable({
  events,
  canManage,
  onCorrect,
  onReverse,
}: {
  events: SettlementEventRow[];
  canManage: boolean;
  onCorrect: (event: SettlementEventRow) => void;
  onReverse: (event: SettlementEventRow) => void;
}) {
  const columnCount = canManage ? 9 : 8;
  return (
    <div className="scroll-thin relative max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
      <table className={`w-full ${canManage ? "min-w-[1280px]" : "min-w-[1120px]"} table-fixed border-collapse text-sm`}>
        <caption className="sr-only">Complete payment and reversal history</caption>
        <colgroup>
          <col className="w-32" />
          <col className="w-44" />
          <col className="w-44" />
          <col className="w-28" />
          <col className="w-28" />
          <col className="w-44" />
          <col className="w-56" />
          <col className="w-36" />
          {canManage ? <col className="w-40" /> : null}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-[var(--color-surface-strong)] text-left">
          <tr className="border-b border-[var(--color-rule-strong)]">
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Entry</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Person</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Item</th>
            <th className="px-3 py-2 text-right text-xs font-semibold text-[var(--color-ink-faint)]">Amount</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Occurred</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Reference</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Note</th>
            <th className="px-3 py-2 text-xs font-semibold text-[var(--color-ink-faint)]">Recorded by</th>
            {canManage ? <th className="px-3 py-2"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const reversed = event.reversedByEventId !== null;
            const isReversal = event.eventType === "reversal";
            return (
              <tr key={event.id} className="border-b border-[var(--color-rule)] last:border-0 hover:bg-[var(--color-surface-muted)]">
                <td className="px-3 py-2 align-top">
                  <span className={`font-medium ${isReversal ? "text-[var(--color-danger)]" : ""}`}>
                    {eventLabel(event)}
                  </span>
                  {reversed ? <span className="mt-1 block text-xs font-medium text-[var(--color-danger)]">Reversed</span> : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <Link href={personHref(event.personType, event.personId)} className="block truncate font-medium text-[var(--color-primary)] hover:underline" title={event.personName}>
                    {event.personName}
                  </Link>
                  <span className="text-xs capitalize text-[var(--color-ink-faint)]">{event.personType}</span>
                </td>
                <td className="px-3 py-2 align-top">
                  <span className="block truncate font-medium" title={event.obligationLabel ?? undefined}>{event.obligationLabel ?? "Ledger item"}</span>
                  <span className="block truncate text-xs text-[var(--color-ink-faint)]" title={eventItemIdentity(event)}>{eventItemIdentity(event)}</span>
                </td>
                <td className={`tnum px-3 py-2 text-right align-top font-semibold ${isReversal ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(event.amount)}</td>
                <td className="px-3 py-2 align-top text-xs">{formatDate(event.occurredOn)}</td>
                <td className="px-3 py-2 align-top text-xs text-[var(--color-ink-soft)]">
                  <span className="block truncate" title={event.reference ?? undefined}>{event.reference ?? "-"}</span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-[var(--color-ink-soft)]">
                  <span className="line-clamp-2 whitespace-pre-wrap" title={event.note ?? undefined}>{event.note ?? "-"}</span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-[var(--color-ink-soft)]">
                  <span className="block truncate" title={event.actorName ?? "System"}>{event.actorName ?? "System"}</span>
                  <span className="text-[var(--color-ink-faint)]">{formatDate(event.createdAt.slice(0, 10))}</span>
                </td>
                {canManage ? <td className="px-3 py-2 text-right align-top">
                  {!isReversal && !reversed ? <div className="flex justify-end gap-1">
                    {event.eventType === "payment" || event.eventType === "set_aside" ? (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onCorrect(event)}>Correct</button>
                    ) : null}
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => onReverse(event)}>Reverse</button>
                  </div> : null}
                </td> : null}
              </tr>
            );
          })}
          {events.length === 0 ? (
            <tr><td colSpan={columnCount} className="px-4 py-12 text-center text-sm text-[var(--color-ink-faint)]">No history matches this search.</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function SettleModal({ rows, onClose, onDone }: { rows: SettlementRow[]; onClose: () => void; onDone: (message: string) => void }) {
  const [operationKey] = useState(() => crypto.randomUUID());
  const [occurredOn, setOccurredOn] = useState(localToday);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => rows.reduce(
    (current, row) => ({ ...current, [row.direction]: current[row.direction].plus(row.balance) }),
    { payable: dec(0), receivable: dec(0), reserve: dec(0) },
  ), [rows]);
  const directions = useMemo(() => new Set(rows.map((row) => row.direction)), [rows]);
  const actionCopy = directions.size !== 1
    ? { title: "Record selected balances", button: `Record ${rows.length} balances`, done: "balances" }
    : directions.has("payable")
      ? { title: "Record agency payments", button: `Record ${rows.length} payments`, done: "agency payments" }
      : directions.has("receivable")
        ? { title: "Record amounts received", button: `Record ${rows.length} receipts`, done: "amounts received" }
        : { title: "Record annual reserves", button: `Record ${rows.length} reserves`, done: "reserves" };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/settlements/events", {
        action: "settle",
        obligationIds: rows.map((row) => row.id),
        occurredOn,
        operationKey,
        reference,
        note,
      });
      onDone(`Recorded ${rows.length} ${actionCopy.done}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The payments could not be recorded.");
      setBusy(false);
    }
  };

  return (
    <Modal title={actionCopy.title} onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">
          This records each of the {rows.length} selected remaining balances separately.
        </p>
        <dl className="grid grid-cols-1 gap-2 border-y border-[var(--color-rule)] py-3 sm:grid-cols-3">
          <div><dt className="text-xs text-[var(--color-ink-faint)]">Agency pays</dt><dd className="tnum font-semibold">{formatMoney(totals.payable)}</dd></div>
          <div><dt className="text-xs text-[var(--color-ink-faint)]">Agency receives</dt><dd className="tnum font-semibold">{formatMoney(totals.receivable)}</dd></div>
          <div><dt className="text-xs text-[var(--color-ink-faint)]">Set aside</dt><dd className="tnum font-semibold">{formatMoney(totals.reserve)}</dd></div>
        </dl>
        <label className="block text-sm font-medium">
          Payment date
          <input type="date" required value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} className="input mt-1 w-full" placeholder="Check, transfer, or batch reference" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || rows.length === 0 || !occurredOn} className="btn btn-sm btn-primary">
            {busy ? "Recording..." : actionCopy.button}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PaymentModal({ row, onClose, onDone }: { row: SettlementRow; onClose: () => void; onDone: (message: string) => void }) {
  const [operationKey] = useState(() => crypto.randomUUID());
  const startingAmount = dec(row.balance).greaterThan(0) ? dec(row.balance).toString() : "";
  const [amount, setAmount] = useState(startingAmount);
  const [occurredOn, setOccurredOn] = useState(localToday);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedAmount = parsePositiveAmount(amount);
  const nextBalance = parsedAmount ? dec(row.balance).minus(parsedAmount) : null;
  const amountLabel = row.direction === "reserve" ? "Amount set aside" : row.direction === "receivable" ? "Amount received" : "Amount paid";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parsedAmount) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/settlements/events", {
        action: "payment",
        obligationId: row.id,
        amount: amount.trim(),
        occurredOn,
        operationKey,
        reference,
        note,
      });
      onDone(`Recorded ${formatMoney(parsedAmount)} for ${row.personName}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The amount could not be recorded.");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Record amount - ${row.personName}`} onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <div>
          <p className="text-sm font-medium">{row.label}</p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
            <span>Original <strong className="tnum text-[var(--color-ink)]">{formatMoney(row.originalAmount)}</strong></span>
            <span>Applied <strong className="tnum text-[var(--color-ink)]">{formatMoney(row.appliedAmount)}</strong></span>
            <span>Balance <strong className="tnum text-[var(--color-ink)]">{formatMoney(row.balance)}</strong></span>
          </div>
        </div>
        <label className="block text-sm font-medium">
          {amountLabel}
          <input
            autoFocus
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input tnum mt-1 w-full"
            placeholder="0.00"
            aria-describedby="payment-balance-preview"
          />
        </label>
        <p id="payment-balance-preview" className={`text-sm ${nextBalance?.isNegative() ? "font-medium text-[var(--color-primary)]" : "text-[var(--color-ink-soft)]"}`}>
          {!nextBalance
            ? "Enter the amount that actually moved."
            : nextBalance.isNegative()
              ? `This creates a credit of ${formatMoney(nextBalance.abs())}.`
              : nextBalance.isZero()
                ? "This settles the balance exactly."
                : `${formatMoney(nextBalance)} will remain.`}
        </p>
        <label className="block text-sm font-medium">
          Date
          <input type="date" required value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} className="input mt-1 w-full" placeholder="Check or transfer reference" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !parsedAmount || !occurredOn} className="btn btn-sm btn-primary">
            {busy ? "Recording..." : "Record amount"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CreditModal({
  source,
  targets,
  onClose,
  onDone,
}: {
  source: SettlementRow;
  targets: SettlementRow[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const initialTarget = targets[0];
  const creditAvailable = dec(source.balance).abs();
  const initialAmount = initialTarget
    ? (creditAvailable.lessThan(dec(initialTarget.balance)) ? creditAvailable : dec(initialTarget.balance)).toString()
    : "";
  const [operationKey] = useState(() => crypto.randomUUID());
  const [targetId, setTargetId] = useState(initialTarget?.id ?? "");
  const [amount, setAmount] = useState(initialAmount);
  const [occurredOn, setOccurredOn] = useState(localToday);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((row) => row.id === targetId) ?? null;
  const parsedAmount = parsePositiveAmount(amount);
  const maximum = target
    ? (creditAvailable.lessThan(dec(target.balance)) ? creditAvailable : dec(target.balance))
    : dec(0);
  const validAmount = parsedAmount !== null && parsedAmount.lessThanOrEqualTo(maximum);

  const chooseTarget = (id: string) => {
    setTargetId(id);
    const next = targets.find((row) => row.id === id);
    if (next) {
      const nextMaximum = creditAvailable.lessThan(dec(next.balance)) ? creditAvailable : dec(next.balance);
      setAmount(nextMaximum.toString());
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || !parsedAmount || !validAmount) {
      setError(`Enter an amount no greater than ${formatMoney(maximum)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/settlements/events", {
        action: "apply_credit",
        sourceObligationId: source.id,
        targetObligationId: target.id,
        amount: parsedAmount.toString(),
        occurredOn,
        operationKey,
        reference,
        note,
      });
      onDone(`Applied ${formatMoney(parsedAmount)} of credit for ${source.personName}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The credit could not be applied.");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Use credit - ${source.personName}`} onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">
          Available credit <strong className="tnum text-[var(--color-ink)]">{formatMoney(creditAvailable)}</strong>
        </p>
        <label className="block text-sm font-medium">
          Apply to
          <select required value={targetId} onChange={(event) => chooseTarget(event.target.value)} className="input mt-1 w-full">
            {targets.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label} | {formatDate(rowDate(row))} | {formatMoney(row.balance)} remaining
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Credit amount
          <input
            autoFocus
            required
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input tnum mt-1 w-full"
            aria-describedby="credit-amount-limit"
          />
        </label>
        <p id="credit-amount-limit" className="text-xs text-[var(--color-ink-soft)]">
          Up to {formatMoney(maximum)} can be applied to this balance.
        </p>
        <label className="block text-sm font-medium">
          Date
          <input type="date" required value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} className="input mt-1 w-full" placeholder="Check or transfer reference" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !target || !validAmount || !occurredOn} className="btn btn-sm btn-primary">
            {busy ? "Applying..." : "Apply credit"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RefundModal({
  row,
  onClose,
  onDone,
}: {
  row: SettlementRow;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const creditAvailable = dec(row.balance).abs();
  const [operationKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState(creditAvailable.toString());
  const [occurredOn, setOccurredOn] = useState(localToday);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedAmount = parsePositiveAmount(amount);
  const validAmount = parsedAmount !== null && parsedAmount.lessThanOrEqualTo(creditAvailable);
  const isReserve = row.direction === "reserve";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parsedAmount || !validAmount) {
      setError(`Enter an amount no greater than ${formatMoney(creditAvailable)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/settlements/events", {
        action: "refund",
        obligationId: row.id,
        amount: parsedAmount.toString(),
        occurredOn,
        operationKey,
        reference,
        note,
      });
      onDone(`${isReserve ? "Released" : "Refunded"} ${formatMoney(parsedAmount)} for ${row.personName}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The credit could not be resolved.");
      setBusy(false);
    }
  };

  return (
    <Modal title={`${isReserve ? "Release excess reserve" : "Record credit refund"} - ${row.personName}`} onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <div>
          <p className="text-sm font-medium">{row.label}</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Available credit <strong className="tnum text-[var(--color-ink)]">{formatMoney(creditAvailable)}</strong></p>
        </div>
        <label className="block text-sm font-medium">
          {isReserve ? "Amount released" : "Amount refunded"}
          <input autoFocus required type="text" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className="input tnum mt-1 w-full" aria-describedby="refund-credit-limit" />
        </label>
        <p id="refund-credit-limit" className="text-xs text-[var(--color-ink-soft)]">Up to {formatMoney(creditAvailable)} can be {isReserve ? "released" : "refunded"}. The ledger keeps the original activity and appends this adjustment.</p>
        <label className="block text-sm font-medium">
          Date
          <input type="date" required value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} className="input mt-1 w-full" placeholder="Check or transfer reference" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !validAmount || !occurredOn} className="btn btn-sm btn-primary">{busy ? "Recording..." : isReserve ? "Release reserve" : "Record refund"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CorrectionModal({ event, onClose, onDone }: { event: SettlementEventRow; onClose: () => void; onDone: (message: string) => void }) {
  const [operationKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState(() => dec(event.amount).abs().toString());
  const [occurredOn, setOccurredOn] = useState(event.occurredOn);
  const [reference, setReference] = useState(event.reference ?? "");
  const [note, setNote] = useState(event.note ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedAmount = parsePositiveAmount(amount);

  const submit = async (formEvent: React.FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!parsedAmount) {
      setError("Enter a corrected amount greater than zero.");
      return;
    }
    if (!reason.trim()) {
      setError("Enter a reason for the correction.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/settlements/events/${encodeURIComponent(event.id)}/correct`, {
        amount: parsedAmount.toString(),
        occurredOn,
        reference,
        note,
        reason,
        operationKey,
      });
      onDone(`Corrected the entry for ${event.personName} to ${formatMoney(parsedAmount)}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The entry could not be corrected.");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Correct ${event.eventType === "set_aside" ? "set-aside" : "payment"} entry`} onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">The original {formatMoney(event.amount)} entry remains in history. Saving adds its exact reversal and a corrected replacement in one operation.</p>
        <label className="block text-sm font-medium">
          Corrected amount
          <input autoFocus required type="text" inputMode="decimal" value={amount} onChange={(changeEvent) => setAmount(changeEvent.target.value)} className="input tnum mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Corrected date
          <input type="date" required value={occurredOn} onChange={(changeEvent) => setOccurredOn(changeEvent.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Reference <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <input value={reference} onChange={(changeEvent) => setReference(changeEvent.target.value)} className="input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium">
          Note <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span>
          <textarea value={note} onChange={(changeEvent) => setNote(changeEvent.target.value)} rows={2} className="input mt-1 w-full resize-y" />
        </label>
        <label className="block text-sm font-medium">
          Correction reason
          <textarea required value={reason} onChange={(changeEvent) => setReason(changeEvent.target.value)} rows={3} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !parsedAmount || !occurredOn || !reason.trim()} className="btn btn-sm btn-primary">{busy ? "Correcting..." : "Save correction"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ReverseModal({ event, onClose, onDone }: { event: SettlementEventRow; onClose: () => void; onDone: (message: string) => void }) {
  const [operationKey] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reversesCreditPair = event.batchAction === "apply_credit" && event.pairedObligationId !== null;

  const submit = async (formEvent: React.FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!reason.trim()) {
      setError("Enter a reason for the reversal.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/settlements/events/${encodeURIComponent(event.id)}/reverse`, { reason, operationKey });
      onDone(reversesCreditPair
        ? `Reversed both sides of the ${formatMoney(dec(event.amount).abs())} credit transfer for ${event.personName}.`
        : `Reversed the ${formatMoney(event.amount)} entry for ${event.personName}.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The entry could not be reversed.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Reverse money entry" onClose={busy ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? <p role="alert" className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">
          Reverse <strong className="tnum text-[var(--color-ink)]">{formatMoney(reversesCreditPair ? dec(event.amount).abs() : event.amount)}</strong> for <strong className="text-[var(--color-ink)]">{event.personName}</strong> from {formatDate(event.occurredOn)}.
        </p>
        {reversesCreditPair ? (
          <p className="rounded border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-ink)]">
            This reverses both sides of the credit transfer: {event.obligationLabel ?? "this ledger item"} ({eventItemIdentity(event)}) and {event.pairedObligationLabel ?? "the paired ledger item"} ({eventItemIdentity({
              checkNumber: event.pairedCheckNumber,
              checkDate: event.pairedCheckDate,
              periodBegin: event.pairedPeriodBegin,
              periodEnd: event.pairedPeriodEnd,
            })}).
          </p>
        ) : null}
        <label className="block text-sm font-medium">
          Reason
          <textarea autoFocus required value={reason} onChange={(changeEvent) => setReason(changeEvent.target.value)} rows={3} className="input mt-1 w-full resize-y" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !reason.trim()} className="btn btn-sm btn-danger">
            {busy ? "Reversing..." : "Reverse entry"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

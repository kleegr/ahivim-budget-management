"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { ReceiptText } from "lucide-react";
import { Money, Notice, Td, Th, Tr } from "@/components/ui";
import type {
  AgencyFinancialReport,
  AutomaticIncomeSourceMatch,
  MonthlySetAsideActual,
} from "@/lib/data/agency-financial-report";
import type { ManualIncomeSource } from "@/lib/manage/agency-financials";
import { formatMoney, formatPercent } from "@/lib/money";

export type View = "summary" | "transactions" | "checks" | "set-asides" | "other-income" | "rules";

export const SOURCE_LABEL: Record<ManualIncomeSource, string> = {
  class: "Class payment received",
  reimbursement: "Reimbursement",
  custom_program: "Custom program",
  other: "Other income",
};

/** Transport helper; each form caller owns its visible busy/disabled state. */
export async function request(
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

export const VIEWS: { id: View; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "transactions", label: "Transactions" },
  { id: "checks", label: "Checks" },
  { id: "set-asides", label: "Set-asides" },
  { id: "other-income", label: "Other income" },
  { id: "rules", label: "Rules" },
];

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`));
}

export function shiftMonth(month: string, amount: number): string {
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, part! - 1 + amount, 1)).toISOString().slice(0, 7);
}

export function percent(value: string | null): string {
  return value === null ? "Not set" : formatPercent(value, 2);
}

const RULE_EFFECTIVE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

export function ruleEffectiveLabel(value: string | null): string {
  if (value === null) return "Not reconstructable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : RULE_EFFECTIVE_TIME.format(parsed);
}

export function SetAsideRuleSource({ row }: { row: MonthlySetAsideActual }) {
  if (!row.historyAvailable) {
    return <span className="font-medium text-[var(--color-danger)]">History unavailable</span>;
  }
  if (row.stateSource !== "saved_revision") return <>Current setup</>;
  return (
    <div className="min-w-48" title={row.revisionId ?? undefined}>
      <p className="font-medium text-[var(--color-ink)]">History snapshot #{row.revisionNumber}</p>
      <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Superseded because: {row.revisionReason?.trim() || "Not recorded"}</p>
      <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Snapshot recorded {ruleEffectiveLabel(row.revisionCreatedAt)}</p>
    </div>
  );
}


export function SummaryMetric({
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

export function TransactionMoneyBridge({
  report,
  onOpenTransactions,
}: {
  report: AgencyFinancialReport;
  onOpenTransactions: () => void;
}) {
  const breakdown = report.transactionBreakdown;
  const incomplete = breakdown.excludedRows > 0 || breakdown.agencyRouted.excludedRows > 0;
  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-rule)] px-5 py-3.5">
        <div>
          <h2 className="display text-base font-semibold">How transaction income is divided</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--color-ink-soft)]">
            Funder billed is the income source. Employee base and Agency spread explain that income; the deal divides only Employee base.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onOpenTransactions}>
          <ReceiptText className="h-4 w-4" aria-hidden /> View source rows
        </button>
      </header>
      <SimpleTable
        caption="Transaction income, base, spread, and agency-routed deal reconciliation"
        headers={[
          { label: "Scope" },
          { label: "Complete rows", numeric: true },
          { label: "Funder billed", numeric: true },
          { label: "Employee base", numeric: true },
          { label: "Agency spread", numeric: true },
          { label: "Employee share of base", numeric: true },
          { label: "Agency share of base", numeric: true },
        ]}
      >
        <Tr>
          <Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={onOpenTransactions}>All transactions with complete base facts</button></Td>
          <Td numeric>{breakdown.completeRows}</Td>
          <Td numeric><Money value={breakdown.funderBilled} /></Td>
          <Td numeric><Money value={breakdown.employeeBase} /></Td>
          <Td numeric><Money value={breakdown.agencySpread} /></Td>
          <Td numeric><span className="text-[var(--color-ink-faint)]">Check or deal level</span></Td>
          <Td numeric><span className="text-[var(--color-ink-faint)]">Check or deal level</span></Td>
        </Tr>
        <Tr>
          <Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={onOpenTransactions}>Agency-routed rows with a complete deal</button></Td>
          <Td numeric>{breakdown.agencyRouted.completeRows}</Td>
          <Td numeric><Money value={breakdown.agencyRouted.funderBilled} /></Td>
          <Td numeric><Money value={breakdown.agencyRouted.employeeBase} /></Td>
          <Td numeric><Money value={breakdown.agencyRouted.agencySpread} /></Td>
          <Td numeric><Money value={breakdown.agencyRouted.employeeShareOfBase} /></Td>
          <Td numeric><Money value={breakdown.agencyRouted.agencyShareOfBase} /></Td>
        </Tr>
      </SimpleTable>
      <div className="border-t border-[var(--color-rule)] px-5 py-3 text-xs leading-5 text-[var(--color-ink-soft)]">
        <p><strong className="text-[var(--color-ink)]">All complete rows:</strong> Funder billed = Employee base + Agency spread.</p>
        <p><strong className="text-[var(--color-ink)]">Agency-routed rows:</strong> Funder billed = Agency spread + Employee share of base + Agency share of base.</p>
        <p>Direct-pay deal amounts stay check-level and use verified net; open Checks for gross, net, withholding, employee keep, and give-back.</p>
      </div>
      {incomplete ? (
        <div className="border-t border-[var(--color-rule)] px-5 py-4">
          <Notice tone="warning" title="Incomplete values stay out of the money split">
            {breakdown.excludedRows} transaction row{breakdown.excludedRows === 1 ? "" : "s"} lack a complete billed/base split; {breakdown.agencyRouted.excludedRows} agency-routed row{breakdown.agencyRouted.excludedRows === 1 ? "" : "s"} lack a complete billed/base/deal split. Known billed income still counts, but missing base, spread, or deal amounts are not guessed.
          </Notice>
        </div>
      ) : null}
    </section>
  );
}

export function SimpleTable({
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
      <table className="touch-table min-w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead><tr className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)]">
          {headers.map((header) => <Th key={header.label} numeric={header.numeric}>{header.label}</Th>)}
        </tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function AutomaticSourceLink({
  source,
  month,
}: {
  source: AutomaticIncomeSourceMatch;
  month: string;
}) {
  const sheet = source.sourceType === "google_sheet_transaction";
  return (
    <Link
      className="touch-target inline-flex items-center px-1 font-semibold text-[var(--color-primary)] hover:underline"
      href={sheet ? `/transactions?transactionId=${source.sourceId}` : `/classes?month=${month}`}
    >
      {sheet ? "Google Sheet" : "Invoice"} {source.sourceRef}
    </Link>
  );
}

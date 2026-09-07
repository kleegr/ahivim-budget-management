import { dec } from "@/lib/money";
import { isPaidCell } from "@/lib/excel/column-map";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";

export interface SheetSourceIdentity {
  /** Normalized, human-readable payment routing evidence from Pay To. */
  payTo: string | null;
  checkNumber: string | null;
  checkDate: string | null;
  program: string | null;
  individual: string | null;
  employee: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  hours: string;
  rate: string;
  amount: string;
  /** Normalized source check-net evidence; null means the source was blank. */
  totalNetPay: string | null;
  /** Paid state observed in the inbound source; retained as raw source evidence. */
  sourcePaid: boolean;
}

export function sheetSourceIdentity(parsed: ParsedAhivimRow): SheetSourceIdentity | { raw: string } {
  const p = parsed.parsed;
  if (!p) return { raw: JSON.stringify(parsed.raw) };
  return {
    payTo: readableText(p.payTo),
    checkNumber: p.checkNumber || null,
    checkDate: p.checkDate || null,
    program: p.programDescription,
    individual: p.individual,
    employee: p.employee || null,
    periodBegin: p.periodBegin || null,
    periodEnd: p.periodEnd || null,
    hours: p.hours,
    rate: p.rate,
    amount: p.amount,
    totalNetPay: readableNumber(p.totalNetPay),
    sourcePaid: isPaidCell(p.paid),
  };
}

const text = (value: unknown): string => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function readableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized || null;
}

function readableNumber(value: unknown): string | null {
  const normalized = readableText(value);
  if (normalized === null) return null;
  try {
    return dec(normalized).toFixed(4);
  } catch {
    return normalized;
  }
}

function number(value: unknown): string | null {
  try {
    return dec(String(value ?? "0")).toFixed(4);
  } catch {
    return null;
  }
}

function canonicalIdentityParts(identity: Record<string, unknown>): string[] | null {
  const hours = number(identity.hours);
  const rate = number(identity.rate);
  const amount = number(identity.amount);
  if (hours === null || rate === null || amount === null) return null;
  return [
    text(identity.checkNumber),
    text(identity.checkDate),
    text(identity.program),
    text(identity.individual),
    text(identity.employee),
    text(identity.periodBegin),
    text(identity.periodEnd),
    hours,
    rate,
    amount,
  ];
}

/**
 * A source-facing identity used only to locate the same row after spreadsheet
 * reordering. It intentionally ignores the Paid cell, which is retained only
 * as raw source evidence, and normalizes numeric display differences such as
 * 25/25.00.
 */
export function sheetSourceIdentityKey(identity: Record<string, unknown>): string | null {
  if (typeof identity.raw === "string") return null;
  const parts = canonicalIdentityParts(identity);
  return parts ? JSON.stringify(parts) : null;
}

export const SOURCE_EVIDENCE_KEY_VERSION = "v2";
export const SOURCE_EVIDENCE_CONFLICT_MARKER = "routing_or_net";

/**
 * Versioned identity for comparing routing/net source evidence within one
 * already-associated canonical transaction. Canonical hours/rate/amount are
 * deliberately excluded: changing one of those fields must not masquerade as
 * a Pay To or Total Net Pay change. Paid is also excluded because it remains an
 * application-owned Neon decision.
 */
export function sourceEvidenceKey(identity: Record<string, unknown>): string | null {
  if (typeof identity.raw === "string") return null;
  const net = readableNumber(identity.totalNetPay);
  return `sheet-source-evidence:${SOURCE_EVIDENCE_KEY_VERSION}:${JSON.stringify([
    text(identity.payTo),
    net === null ? null : number(net) ?? `invalid:${text(net)}`,
  ])}`;
}


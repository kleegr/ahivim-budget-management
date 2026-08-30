import { dec } from "@/lib/money";
import { isPaidCell } from "@/lib/excel/column-map";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";

export interface SheetSourceIdentity {
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
  /** Paid state last read from Google Sheets. Used to identify later app edits. */
  sourcePaid: boolean;
}

export function sheetSourceIdentity(parsed: ParsedAhivimRow): SheetSourceIdentity | { raw: string } {
  const p = parsed.parsed;
  if (!p) return { raw: JSON.stringify(parsed.raw) };
  return {
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
    sourcePaid: isPaidCell(p.paid),
  };
}

const text = (value: unknown): string => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function number(value: unknown): string | null {
  try {
    return dec(String(value ?? "0")).toFixed(4);
  } catch {
    return null;
  }
}

/**
 * A source-facing identity used only to locate the same row after spreadsheet
 * reordering. It intentionally ignores the Paid cell, which is the value being
 * synchronized, and normalizes numeric display differences such as 25/25.00.
 */
export function sheetSourceIdentityKey(identity: Record<string, unknown>): string | null {
  if (typeof identity.raw === "string") return null;
  const hours = number(identity.hours);
  const rate = number(identity.rate);
  const amount = number(identity.amount);
  if (hours === null || rate === null || amount === null) return null;
  return JSON.stringify([
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
  ]);
}


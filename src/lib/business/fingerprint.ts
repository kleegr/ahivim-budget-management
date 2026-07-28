import { createHash } from "node:crypto";
import { dec, type MoneyInput } from "@/lib/money";

/**
 * DUPLICATE PROTECTION
 * ====================
 *
 * Two independent layers:
 *
 *  1. File level   - SHA-256 of the raw upload bytes. The same workbook can
 *                    never be committed twice.
 *  2. Transaction  - a documented composite fingerprint. Check number ALONE is
 *                    never used: one check routinely carries many unrelated
 *                    transactions and can span more than one employee.
 *
 * Suspected duplicates are classified, never deleted:
 *    confirmed  - identical fingerprint already committed
 *    possible   - same natural key but a differing money or hours figure
 *    new        - not seen before
 */

export function fileChecksum(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface TransactionIdentity {
  checkNumber: string | null;
  checkDate: string | null;
  employeeKey: string | null;
  individualKey: string | null;
  programKey: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  hours: MoneyInput;
  rate: MoneyInput;
  amount: MoneyInput;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/**
 * Fields participating in the fingerprint, in order. Documented here because
 * changing this set invalidates every previously stored fingerprint.
 */
export const FINGERPRINT_FIELDS = [
  "checkNumber",
  "checkDate",
  "employeeKey",
  "individualKey",
  "programKey",
  "periodBegin",
  "periodEnd",
  "hours",
  "rate",
  "amount",
] as const;

export function transactionFingerprint(tx: TransactionIdentity): string {
  const parts = [
    norm(tx.checkNumber),
    norm(tx.checkDate),
    norm(tx.employeeKey),
    norm(tx.individualKey),
    norm(tx.programKey),
    norm(tx.periodBegin),
    norm(tx.periodEnd),
    dec(tx.hours).toFixed(4),
    dec(tx.rate).toFixed(4),
    dec(tx.amount).toFixed(4),
  ];
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

/**
 * The "natural key" is the fingerprint minus the money and hours. Two rows
 * sharing a natural key but differing on amounts are a POSSIBLE duplicate -
 * often a correction - and must be reviewed rather than dropped.
 */
export function transactionNaturalKey(tx: TransactionIdentity): string {
  const parts = [
    norm(tx.checkNumber),
    norm(tx.checkDate),
    norm(tx.employeeKey),
    norm(tx.individualKey),
    norm(tx.programKey),
    norm(tx.periodBegin),
    norm(tx.periodEnd),
  ];
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

export type DuplicateStatus = "new" | "possible" | "confirmed";

export interface DuplicateCheckResult {
  status: DuplicateStatus;
  fingerprint: string;
  naturalKey: string;
  reason: string;
}

export function classifyDuplicate(
  tx: TransactionIdentity,
  known: { fingerprints: ReadonlySet<string>; naturalKeys: ReadonlySet<string> },
): DuplicateCheckResult {
  const fingerprint = transactionFingerprint(tx);
  const naturalKey = transactionNaturalKey(tx);

  if (known.fingerprints.has(fingerprint)) {
    return {
      status: "confirmed",
      fingerprint,
      naturalKey,
      reason: "An identical transaction has already been imported.",
    };
  }
  if (known.naturalKeys.has(naturalKey)) {
    return {
      status: "possible",
      fingerprint,
      naturalKey,
      reason:
        "A transaction with the same check, employee, individual, program and pay period " +
        "exists with different hours, rate or amount. Review before importing.",
    };
  }
  return { status: "new", fingerprint, naturalKey, reason: "Not previously imported." };
}

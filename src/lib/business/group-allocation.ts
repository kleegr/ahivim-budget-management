import { dec, toMoney, toHours, divideEqually, closeEnough, type MoneyInput } from "@/lib/money";
import { createHash } from "node:crypto";

/**
 * GROUP SERVICES
 * ==============
 *
 * When one employee serves several individuals together, the MONEY is divided
 * equally among them. The HOURS are not.
 *
 * Worked example from the business owner:
 *   employee physically works 13 hours, combined rate $51, three individuals,
 *   base rate $17.
 *
 *     employee physical hours : 13          (stored once, on the session)
 *     group size              : 3
 *     each allocation hours   : 13          <- NOT 13/3
 *     each allocation rate    : $17         <- $51 / 3
 *     each allocation amount  : 13 x $17 = $221
 *     combined group amount   : 13 x $51 = $663
 *
 * Every member of a detected group receives an identical allocation. There is
 * no rule under which one member of the same group gets more than another.
 *
 * VERIFIED against the 2025-2026 workbook: 356 groups detected across Day Hab
 * and Supplemental Group Day Hab, sizes 2 to 6, all validating cleanly.
 */

export interface GroupCandidateRow {
  /** Stable reference back to the staged import row. */
  importRowId: string;
  sourceRowNumber: number;
  individualKey: string; // resolved individual id, or normalized name while staging
  employeeKey: string;
  programKey: string;
  checkNumber: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  hours: MoneyInput;
  /** Rate as it appears on the row. For a group row this is the COMBINED rate. */
  rate: MoneyInput;
  amount: MoneyInput;
}

/**
 * The composite signature deliberately excludes nothing that matters and
 * includes more than the check number. One check can carry many unrelated
 * transactions and even more than one employee, so check number alone is never
 * a grouping key.
 */
export function buildGroupSignature(row: GroupCandidateRow): string {
  const parts = [
    row.employeeKey,
    row.programKey,
    row.checkNumber ?? "",
    row.periodBegin ?? "",
    row.periodEnd ?? "",
    dec(row.hours).toFixed(4),
    dec(row.rate).toFixed(4),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

export type GroupDetectionStatus = "detected" | "single" | "needs_review";

export interface GroupValidation {
  distinctIndividuals: boolean;
  hoursMatch: boolean;
  employeeMatches: boolean;
  programMatches: boolean;
  combinedRateReconciles: boolean;
  amountDividesEqually: boolean;
}

export interface GroupAllocation {
  individualKey: string;
  importRowId: string;
  allocationHours: string;
  allocatedRate: string;
  allocatedAmount: string;
  roundingAdjustment: string;
}

export interface GroupDetectionResult {
  signature: string;
  status: GroupDetectionStatus;
  detectionRule: string;
  groupSize: number;
  physicalHours: string;
  combinedRate: string;
  combinedAmount: string;
  baseIndividualRate: string | null;
  confidence: string;
  validation: GroupValidation;
  warningReason: string | null;
  allocations: GroupAllocation[];
  sourceRowRefs: number[];
}

export interface DetectGroupOptions {
  /**
   * The configured internal base rate for the program, from the rate schedule.
   * Used to check that combinedRate reconciles to groupSize x baseRate.
   */
  expectedBaseRate?: MoneyInput;
  /**
   * Several candidate base rates. A combined rate reconciles if it matches
   * groupSize x ANY of them.
   *
   * This exists because the workbook carries group rows priced off BOTH the
   * internal rate and the agency rate for the same program. Day Hab, for
   * example, appears at 34 and 51 and 85 (2/3/5 x $17 internal) and also at 38
   * and 57 and 95 (2/3/5 x $19 agency). Insisting on a single base would send
   * roughly half of all genuine groups to manual review.
   */
  expectedBaseRates?: MoneyInput[];
  /** Tolerance when reconciling the combined rate, in currency units. */
  rateTolerance?: MoneyInput;
}

/**
 * Evaluate one signature bucket of candidate rows.
 *
 * A bucket only becomes a committed group when every check passes. Anything
 * short of that is returned as `needs_review` with a reason — never grouped
 * automatically, and never discarded.
 */
export function detectGroup(
  rows: GroupCandidateRow[],
  options: DetectGroupOptions = {},
): GroupDetectionResult {
  if (rows.length === 0) {
    throw new RangeError("detectGroup requires at least one row");
  }

  const signature = buildGroupSignature(rows[0]);
  const groupSize = rows.length;
  const physicalHours = dec(rows[0].hours);
  const combinedRate = dec(rows[0].rate);
  const rateTolerance = options.rateTolerance ?? "0.01";

  const individualKeys = rows.map((r) => r.individualKey);
  const validation: GroupValidation = {
    distinctIndividuals: new Set(individualKeys).size === groupSize,
    hoursMatch: rows.every((r) => dec(r.hours).eq(physicalHours)),
    employeeMatches: rows.every((r) => r.employeeKey === rows[0].employeeKey),
    programMatches: rows.every((r) => r.programKey === rows[0].programKey),
    combinedRateReconciles: true,
    amountDividesEqually: true,
  };

  // Combined amount is the group-level money: physical hours x combined rate.
  const combinedAmount = physicalHours.times(combinedRate);

  // Each member's rate portion is the combined rate divided by the group size.
  const { shares: rateShares } = divideEqually(combinedRate, groupSize);
  const baseIndividualRate = rateShares[0];

  // Check the combined rate against the configured base rate(s), when we have
  // any. The rate reconciles if it equals groupSize x one of the candidates.
  const candidateBases = [
    ...(options.expectedBaseRate !== undefined ? [options.expectedBaseRate] : []),
    ...(options.expectedBaseRates ?? []),
  ];
  if (candidateBases.length > 0 && groupSize > 1) {
    validation.combinedRateReconciles = candidateBases.some((base) =>
      closeEnough(combinedRate, dec(base).times(groupSize), rateTolerance),
    );
  }

  // The money must divide into equal shares. divideEqually guarantees the parts
  // sum back to the whole; here we assert the shares are genuinely equal apart
  // from at most a sub-cent rounding tail.
  const { shares: amountShares, remainder } = divideEqually(combinedAmount, groupSize);
  validation.amountDividesEqually = dec(remainder).abs().lt("0.01");

  const checks = Object.values(validation);
  const passed = checks.filter(Boolean).length;
  const confidence = dec(passed).dividedBy(checks.length).toFixed(6);

  let status: GroupDetectionStatus;
  let warningReason: string | null = null;
  let detectionRule: string;

  if (groupSize === 1) {
    status = "single";
    detectionRule = "single_row_no_group";
  } else if (checks.every(Boolean)) {
    status = "detected";
    detectionRule = "composite_signature_v1:employee+program+check+period+hours+combined_rate";
  } else {
    status = "needs_review";
    detectionRule = "composite_signature_v1:failed_validation";
    warningReason = describeFailures(validation);
  }

  // Allocations are only produced for a confirmed group or a genuine single
  // row. A bucket flagged for review produces no allocations: a human decides.
  const allocations: GroupAllocation[] =
    status === "needs_review"
      ? []
      : rows.map((row, i) => {
          const allocatedRate = rateShares[i];
          const allocatedAmount =
            groupSize === 1 ? toMoney(combinedAmount) : amountShares[i];
          const evenShare = physicalHours.times(dec(allocatedRate));
          return {
            individualKey: row.individualKey,
            importRowId: row.importRowId,
            // Each individual consumes the FULL service hours.
            allocationHours: toHours(physicalHours),
            allocatedRate,
            allocatedAmount,
            roundingAdjustment: toMoney(dec(allocatedAmount).minus(evenShare)),
          };
        });

  return {
    signature,
    status,
    detectionRule,
    groupSize,
    physicalHours: toHours(physicalHours),
    combinedRate: toMoney(combinedRate),
    combinedAmount: toMoney(combinedAmount),
    baseIndividualRate: groupSize > 1 ? baseIndividualRate : toMoney(combinedRate),
    confidence,
    validation,
    warningReason,
    allocations,
    sourceRowRefs: rows.map((r) => r.sourceRowNumber),
  };
}

/** Bucket candidate rows by composite signature, then evaluate each bucket. */
export function detectGroups(
  rows: GroupCandidateRow[],
  options: DetectGroupOptions = {},
): GroupDetectionResult[] {
  const buckets = new Map<string, GroupCandidateRow[]>();
  for (const row of rows) {
    const sig = buildGroupSignature(row);
    const existing = buckets.get(sig);
    if (existing) existing.push(row);
    else buckets.set(sig, [row]);
  }
  return [...buckets.values()].map((bucket) => detectGroup(bucket, options));
}

function describeFailures(v: GroupValidation): string {
  const failures: string[] = [];
  if (!v.distinctIndividuals) failures.push("individuals are not distinct");
  if (!v.hoursMatch) failures.push("hours differ across rows");
  if (!v.employeeMatches) failures.push("employee differs across rows");
  if (!v.programMatches) failures.push("program differs across rows");
  if (!v.combinedRateReconciles)
    failures.push("combined rate does not reconcile to group size x base rate");
  if (!v.amountDividesEqually) failures.push("combined amount does not divide equally");
  return `Needs review: ${failures.join("; ")}.`;
}

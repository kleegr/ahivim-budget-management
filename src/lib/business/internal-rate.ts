import { dec, toMoney, tryDec, type MoneyInput, Decimal } from "@/lib/money";

/**
 * Column P — internal amount.
 *
 * The workbook's logic, restated:
 *   1. Pay to blank                        -> no internal amount at all
 *   2. Pay to is NOT the staffing agency   -> keep the imported gross amount
 *   3. Pay to IS the agency, Com Hab       -> convert agency rate to internal
 *   4. Pay to IS the agency, Respite /
 *      Day Hab / Suppl. Group Day Hab      -> convert agency rate to internal
 *   5. anything else                       -> keep the imported amount
 *
 * VERIFIED against Excellent_Staffing_2025-2026.xlsx. Across all 33 distinct
 * program/rate combinations the ratio of column P to column G is exactly one
 * of three values:
 *
 *   0.84      == 21/25   Com Hab priced on the $25 agency rate
 *   0.894737  == 17/19   Respite / Day Hab / Suppl. Group Day Hab on $19
 *   1.0                  everything else, retained untouched
 *
 * Rates are passed in from `program_rate_schedules`, resolved for the
 * transaction's service date. Nothing here hardcodes 21, 17, 25 or 19.
 */

export const AGENCY_PAYEE_CANONICAL = "excellent staffing";

/** Normalise a payee string for comparison. Preserves the original elsewhere. */
export function normalizePayee(payTo: string | null | undefined): string {
  return (payTo ?? "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(llc|inc|corp|co)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAgencyPayee(payTo: string | null | undefined): boolean {
  const n = normalizePayee(payTo);
  if (!n) return false;
  return n === AGENCY_PAYEE_CANONICAL || n.startsWith(`${AGENCY_PAYEE_CANONICAL} `);
}

export interface InternalAmountInput {
  payTo: string | null | undefined;
  /** Imported gross amount (column G). */
  importedAmount: MoneyInput;
  /** Agency rate for this program on this date, from the rate schedule. */
  agencyRate: MoneyInput;
  /** Internal rate for this program on this date, from the rate schedule. */
  internalRate: MoneyInput;
  /** Hours, retained for auditing. */
  hours?: MoneyInput;
  /**
   * The rate on the row itself. For a group row this is the COMBINED rate,
   * e.g. 57 == 3 x the $19 Day Hab agency rate.
   */
  rowRate?: MoneyInput;
}

export interface InternalAmountResult {
  /** null means "no internal amount", matching a blank Pay to. */
  internalAmount: string | null;
  /** Which branch of the rule fired — surfaced in the transaction detail view. */
  rule:
    | "blank_pay_to"
    | "non_agency_payee_retain_gross"
    | "agency_rate_converted"
    | "retain_imported";
  appliedInternalRate: string | null;
  appliedAgencyRate: string | null;
  /** Ratio used for the conversion, kept for auditability. */
  conversionFactor: string | null;
}

export function calculateInternalAmount(input: InternalAmountInput): InternalAmountResult {
  const payTo = (input.payTo ?? "").trim();

  // 1. Blank Pay to -> no internal amount.
  if (payTo === "") {
    return {
      internalAmount: null,
      rule: "blank_pay_to",
      appliedInternalRate: null,
      appliedAgencyRate: null,
      conversionFactor: null,
    };
  }

  const imported = dec(input.importedAmount);

  // 2. Not the staffing agency -> the gross stands as the internal amount.
  if (!isAgencyPayee(payTo)) {
    return {
      internalAmount: toMoney(imported),
      rule: "non_agency_payee_retain_gross",
      appliedInternalRate: null,
      appliedAgencyRate: null,
      conversionFactor: null,
    };
  }

  const agencyRate = tryDec(input.agencyRate);
  const internalRate = tryDec(input.internalRate);

  // 3/4. Agency payee in a program with a configured agency/internal pair ->
  // ALWAYS convert by the flat ratio internalRate/agencyRate.
  //
  // VERIFIED against the source ledger: 100% of Excellent-Staffing rows in
  // Com Hab / Respite / Day Hab / Supplemental Group Day Hab carry exactly the
  // 0.84 (21/25) or 0.894737 (17/19) ratio of column P to column G — NONE stay
  // at 1.0. The workbook applies the conversion off the PROGRAM and PAYEE alone;
  // the row's own rate never gates it (rows are priced at 15, 18, 20, 22, 25 …
  // and all convert). Conditioning conversion on the row rate being a whole
  // multiple of the agency rate silently left ~$53.6k of non-standard-rate rows
  // unconverted and overstated the internal total.
  //
  // It is a RATIO on the AMOUNT, not a rebuild from hours x internal rate, so a
  // group row's combined amount (e.g. 3 x $19 = $57/hr) scales correctly on its
  // own — the other members' share is never dropped.
  if (agencyRate && internalRate && !agencyRate.isZero() && !internalRate.isZero()) {
    const converted = imported.times(internalRate).dividedBy(agencyRate);
    return {
      internalAmount: toMoney(converted),
      rule: "agency_rate_converted",
      appliedInternalRate: toMoney(internalRate),
      appliedAgencyRate: toMoney(agencyRate),
      conversionFactor: internalRate.dividedBy(agencyRate).toFixed(8),
    };
  }

  // 5. Agency payee but the program has no configured conversion pair (e.g. a
  //    self-hire program) -> keep what was imported, matching the workbook's
  //    "else -> G" branch.
  return {
    internalAmount: toMoney(imported),
    rule: "retain_imported",
    appliedInternalRate: internalRate ? toMoney(internalRate) : null,
    appliedAgencyRate: agencyRate ? toMoney(agencyRate) : null,
    conversionFactor: null,
  };
}

/**
 * Compare the spreadsheet's own column P value against ours.
 *
 * A difference is a WARNING. Neither value is overwritten: both are stored, and
 * a human decides. Silently trusting either side is how a reconciliation error
 * becomes permanent.
 */
export interface InternalAmountComparison {
  matches: boolean;
  difference: string;
  spreadsheetValue: string | null;
  applicationValue: string | null;
}

export function compareInternalAmounts(
  spreadsheetValue: MoneyInput,
  applicationValue: string | null,
  tolerance: MoneyInput = "0.01",
): InternalAmountComparison {
  const sheet = tryDec(spreadsheetValue);
  const app = applicationValue === null ? null : dec(applicationValue);

  if (sheet === null || app === null) {
    return {
      // Nothing to disagree about if one side has no value.
      matches: sheet === null && app === null,
      difference: "0.0000",
      spreadsheetValue: sheet ? toMoney(sheet) : null,
      applicationValue: app ? toMoney(app) : null,
    };
  }

  const difference = app.minus(sheet);
  return {
    matches: difference.abs().lte(dec(tolerance)),
    difference: toMoney(difference),
    spreadsheetValue: toMoney(sheet),
    applicationValue: toMoney(app),
  };
}

/**
 * True when `value` is a whole-number multiple of `base` (1x, 2x, 3x ...).
 *
 * A row priced at 57 against a $19 agency rate is a three-person group and
 * converts. A row priced at 51 is already 3 x the $17 internal rate and must be
 * retained untouched.
 */
export function isIntegerMultiple(
  value: MoneyInput,
  base: MoneyInput,
  tolerance: MoneyInput = "0.0001",
): boolean {
  const b = dec(base);
  if (b.isZero()) return false;
  const quotient = dec(value).dividedBy(b);
  if (quotient.lt(1)) return false;
  return quotient.minus(quotient.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)).abs().lte(dec(tolerance));
}

export { Decimal };

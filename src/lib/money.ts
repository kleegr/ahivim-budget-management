import Decimal from "decimal.js";

/**
 * Money and hours are never JavaScript floats.
 *
 * PostgreSQL numeric values arrive from Drizzle as strings. They stay strings
 * at the boundary and become Decimal in between. `Number` is used only for
 * presentation (progress-bar widths), never for an authoritative value.
 */

// 28 significant digits is far more than payroll needs and avoids surprises
// when chaining percentage math.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = string | number | Decimal | null | undefined;

/** Scale used when persisting money. Matches numeric(14,4) in the schema. */
export const MONEY_SCALE = 4;
/** Scale used when persisting hours. Matches numeric(10,4). */
export const HOURS_SCALE = 4;
/** Scale used for display of currency. */
export const DISPLAY_SCALE = 2;

export function dec(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Refusing to build a Decimal from a non-finite number");
    }
    // Route through the string form so a float literal cannot smuggle in
    // binary rounding error.
    return new Decimal(value.toString());
  }
  // Strip currency symbols, thousands separators (commas OR spaces) and any
  // other whitespace, so a display-formatted cell like "1 888.60" or
  // "10,563.1" parses. In ECMAScript, \s also covers the non-breaking space
  // (U+00A0) and BOM (U+FEFF) that spreadsheet CSV exports emit. Removing
  // whitespace can only rescue a value that would otherwise throw; a clean
  // number is unaffected.
  const trimmed = value.replace(/[\s$,]/g, "");
  if (trimmed === "" || trimmed === "-") return new Decimal(0);
  const parsed = new Decimal(trimmed);
  if (!parsed.isFinite()) {
    throw new TypeError("Refusing to build a Decimal from a non-finite value");
  }
  return parsed;
}

/** Parse a possibly-dirty spreadsheet cell into a Decimal, or null if unusable. */
export function tryDec(value: MoneyInput): Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    const s = typeof value === "string" ? value.trim() : value;
    if (s === "") return null;
    return dec(value);
  } catch {
    return null;
  }
}

/** Serialise for storage in a numeric(14,4) column. */
export function toMoney(value: MoneyInput): string {
  return dec(value).toFixed(MONEY_SCALE);
}

/** Serialise for storage in a numeric(10,4) column. */
export function toHours(value: MoneyInput): string {
  return dec(value).toFixed(HOURS_SCALE);
}

/** Round to cents, half-up. Use before any figure a person will reconcile. */
export function toCents(value: MoneyInput): string {
  return dec(value).toDecimalPlaces(DISPLAY_SCALE, Decimal.ROUND_HALF_UP).toFixed(DISPLAY_SCALE);
}

export function addMoney(...values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((sum, v) => sum.plus(dec(v)), new Decimal(0));
}

export function sumMoney(values: MoneyInput[]): string {
  return toMoney(addMoney(...values));
}

export function eqMoney(a: MoneyInput, b: MoneyInput): boolean {
  return dec(a).eq(dec(b));
}

/**
 * Compare two money values allowing a tolerance, expressed in currency units.
 * Used for reconciliation, where a workbook total and a recomputed total can
 * legitimately differ by sub-cent rounding.
 */
export function closeEnough(a: MoneyInput, b: MoneyInput, tolerance: MoneyInput = "0.01"): boolean {
  return dec(a).minus(dec(b)).abs().lte(dec(tolerance));
}

/** Percentage variance of `actual` against `expected`, as a decimal fraction. */
export function variancePercent(actual: MoneyInput, expected: MoneyInput): Decimal {
  const e = dec(expected);
  if (e.isZero()) return new Decimal(0);
  return dec(actual).minus(e).dividedBy(e);
}

/** Format a decimal fraction (0.075) as a percentage string ("7.5%"). */
export function formatPercent(fraction: MoneyInput, places = 1): string {
  return `${dec(fraction).times(100).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places)}%`;
}

export function formatMoney(value: MoneyInput): string {
  const d = dec(value);
  const negative = d.isNegative();
  const abs = d.abs().toDecimalPlaces(DISPLAY_SCALE, Decimal.ROUND_HALF_UP).toFixed(DISPLAY_SCALE);
  const [whole, frac] = abs.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${frac}`;
}

export function formatHours(value: MoneyInput): string {
  const d = dec(value);
  // Hours read better without trailing zeros: 13, 13.5, 13.25
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString();
}

/**
 * Divide an amount into `parts` equal shares without losing or inventing money.
 *
 * Every share is the same value except that any indivisible remainder is added
 * to the final share, so the shares always sum exactly back to `amount`. The
 * remainder is reported so callers can record it as a rounding adjustment.
 */
export function divideEqually(
  amount: MoneyInput,
  parts: number,
  scale: number = MONEY_SCALE,
): { shares: string[]; remainder: string } {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError("divideEqually requires a positive integer number of parts");
  }
  const total = dec(amount);
  const base = total.dividedBy(parts).toDecimalPlaces(scale, Decimal.ROUND_DOWN);
  const shares = Array.from({ length: parts }, () => base.toFixed(scale));
  const distributed = base.times(parts);
  const remainder = total.minus(distributed);
  if (!remainder.isZero()) {
    shares[parts - 1] = base.plus(remainder).toFixed(scale);
  }
  return { shares, remainder: remainder.toFixed(scale) };
}

export { Decimal };

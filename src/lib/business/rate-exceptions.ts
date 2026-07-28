import { dec, toMoney, variancePercent, type MoneyInput } from "@/lib/money";

/**
 * RATE EXCEPTIONS
 * ===============
 *
 * Self-Hire Respite normally carries an $18/hr internal rate, but imported
 * transactions legitimately arrive above and below it. The imported rate is
 * always preserved and always imported. We calculate what the rate should have
 * been, record the difference in both dollars and percent, say which direction
 * it went, and raise a visible exception.
 *
 * We never quietly rewrite an imported rate to match configuration.
 */

export interface RateExceptionInput {
  importedRate: MoneyInput;
  /** Expected internal rate from `program_rate_schedules` for the service date. */
  expectedRate: MoneyInput;
  /** Absolute tolerance in currency units before a difference is reported. */
  tolerance?: MoneyInput;
}

export interface RateExceptionResult {
  isException: boolean;
  importedRate: string;
  expectedRate: string;
  /** importedRate - expectedRate. Positive means the import was higher. */
  varianceAmount: string;
  /** Decimal fraction: 0.05 == 5% above expected. */
  variancePercent: string;
  direction: "higher" | "lower" | "match";
  /** Human-readable summary used in warnings and the exceptions report. */
  summary: string;
}

export function evaluateRateException(input: RateExceptionInput): RateExceptionResult {
  const imported = dec(input.importedRate);
  const expected = dec(input.expectedRate);
  const tolerance = dec(input.tolerance ?? "0.005");

  const varianceAmount = imported.minus(expected);
  const pct = variancePercent(imported, expected);
  const isException = varianceAmount.abs().gt(tolerance);

  const direction: RateExceptionResult["direction"] = !isException
    ? "match"
    : varianceAmount.isPositive()
      ? "higher"
      : "lower";

  const summary = !isException
    ? `Rate matches the configured ${money(expected)} rate.`
    : `Imported rate ${money(imported)} is ${money(varianceAmount.abs())} ` +
      `(${pct.abs().times(100).toDecimalPlaces(2).toString()}%) ` +
      `${direction} than the configured ${money(expected)} rate.`;

  return {
    isException,
    importedRate: toMoney(imported),
    expectedRate: toMoney(expected),
    varianceAmount: toMoney(varianceAmount),
    variancePercent: pct.toFixed(6),
    direction,
    summary,
  };
}

function money(value: MoneyInput): string {
  return `$${dec(value).toDecimalPlaces(2).toFixed(2)}`;
}

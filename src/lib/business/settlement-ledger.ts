import { computeStrategy, type StrategyInput } from "@/lib/business/calculation-strategy";
import { dec, Decimal, toMoney, type MoneyInput } from "@/lib/money";

export type SettlementDirection = "payable" | "receivable" | "reserve";
export type SettlementState = "open" | "partial" | "settled" | "credit" | "void";

export interface SettlementTargetDelta {
  direction: SettlementDirection;
  amount: string;
  signedAmount: string;
}

export interface IndividualSettlementTarget {
  kind: "individual_cut_1" | "individual_cut_2" | "individual_clock" | "individual_other" | "individual_masser";
  direction: SettlementDirection;
  amount: string;
  monthlyAmount: string | null;
  label: string;
  formula: string;
}

function rounded(value: Decimal): Decimal {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/**
 * Turn the entered approved monthly final into one annual reserve target.
 * The cuts and adjustments explain how the final was reached; they are not
 * separate obligations and must not be added to the approved final again.
 */
export function individualSettlementTargets(input: StrategyInput): IndividualSettlementTarget[] {
  const result = computeStrategy(input);
  const divisor = dec(result.monthDivisor);
  if (!result.afterAll || !dec(result.afterAll).abs().greaterThan(0)) return [];

  const monthly = dec(result.afterAll).abs();
  return [{
    kind: "individual_masser",
    direction: "reserve",
    amount: toMoney(rounded(monthly.times(divisor))),
    monthlyAmount: toMoney(monthly),
    label: "Approved final reserve",
    formula: `approved monthly final x ${result.monthDivisor}`,
  }];
}

export function settlementState(
  originalAmount: MoneyInput,
  appliedAmount: MoneyInput,
  voided = false,
): SettlementState {
  if (voided) return "void";
  const original = rounded(dec(originalAmount));
  const applied = rounded(dec(appliedAmount));
  const balance = rounded(original.minus(applied));
  if (balance.isNegative()) return "credit";
  if (balance.isZero()) return "settled";
  if (applied.greaterThan(0)) return "partial";
  return "open";
}

export function settlementBalance(
  originalAmount: MoneyInput,
  appliedAmount: MoneyInput,
  voided = false,
): string {
  if (voided) return toMoney(0);
  return toMoney(rounded(dec(originalAmount).minus(dec(appliedAmount))));
}

/**
 * Express a recalculated target as one append-only adjustment. Receivables are
 * negative on the shared axis; payables and reserves are positive. Keeping the
 * sign here is what makes a payable-to-receivable correction become the full
 * reversal plus the new amount, without silently netting the displayed rows.
 */
export function settlementTargetDelta(input: {
  previousAmount: MoneyInput;
  previousDirection: SettlementDirection;
  nextAmount: MoneyInput;
  nextDirection: SettlementDirection;
  positiveDirection: "payable" | "reserve";
}): SettlementTargetDelta | null {
  const previous = input.previousDirection === "receivable"
    ? dec(input.previousAmount).negated()
    : dec(input.previousAmount);
  const next = input.nextDirection === "receivable"
    ? dec(input.nextAmount).negated()
    : dec(input.nextAmount);
  const delta = rounded(next.minus(previous));
  if (delta.isZero()) return null;
  return {
    direction: delta.isPositive() ? input.positiveDirection : "receivable",
    amount: toMoney(delta.abs()),
    signedAmount: toMoney(delta),
  };
}

export function paceComparison(actual: MoneyInput, target: MoneyInput, elapsed: MoneyInput | null): {
  actualPercent: string | null;
  elapsedPercent: string | null;
  variancePercent: string | null;
} {
  const targetAmount = dec(target);
  if (!targetAmount.greaterThan(0)) {
    return { actualPercent: null, elapsedPercent: elapsed == null ? null : dec(elapsed).toString(), variancePercent: null };
  }
  const actualPercent = dec(actual).dividedBy(targetAmount);
  const elapsedPercent = elapsed == null ? null : dec(elapsed);
  return {
    actualPercent: actualPercent.toDecimalPlaces(6).toString(),
    elapsedPercent: elapsedPercent?.toDecimalPlaces(6).toString() ?? null,
    variancePercent: elapsedPercent ? actualPercent.minus(elapsedPercent).toDecimalPlaces(6).toString() : null,
  };
}

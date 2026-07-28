import { dec, toMoney, type MoneyInput, Decimal } from "@/lib/money";

/**
 * Cuts are SEQUENTIAL.
 *
 *   firstCutAmount          = gross * firstCutPercent
 *   remainingAfterFirstCut  = gross - firstCutAmount
 *   secondCutAmount         = remainingAfterFirstCut * secondCutPercent
 *   remainingAfterSecondCut = remainingAfterFirstCut - secondCutAmount
 *
 * The second cut is taken from what is left after the first cut, NOT from the
 * original gross. Getting this wrong silently overstates the second cut on
 * every account, so it is covered directly by tests.
 */
export interface SequentialCutInput {
  gross: MoneyInput;
  firstCutPercent: MoneyInput; // decimal fraction, 0.10 == 10%
  secondCutPercent: MoneyInput;
}

export interface SequentialCutResult {
  gross: string;
  firstCutAmount: string;
  remainingAfterFirstCut: string;
  secondCutAmount: string;
  remainingAfterSecondCut: string;
}

export function calculateSequentialCuts(input: SequentialCutInput): SequentialCutResult {
  const gross = dec(input.gross);
  const firstPct = dec(input.firstCutPercent);
  const secondPct = dec(input.secondCutPercent);

  assertFraction(firstPct, "firstCutPercent");
  assertFraction(secondPct, "secondCutPercent");

  const firstCutAmount = gross.times(firstPct);
  const remainingAfterFirstCut = gross.minus(firstCutAmount);
  const secondCutAmount = remainingAfterFirstCut.times(secondPct);
  const remainingAfterSecondCut = remainingAfterFirstCut.minus(secondCutAmount);

  return {
    gross: toMoney(gross),
    firstCutAmount: toMoney(firstCutAmount),
    remainingAfterFirstCut: toMoney(remainingAfterFirstCut),
    secondCutAmount: toMoney(secondCutAmount),
    remainingAfterSecondCut: toMoney(remainingAfterSecondCut),
  };
}

/**
 * The third cut (the workbook's "After All") is an independent, adjustable
 * amount. It is NOT derived from the remaining balance, and it is never forced
 * to equal it.
 *
 *   employeeCashAmount = remainingAfterSecondCut - thirdCutAmount
 */
export interface ThirdCutInput {
  remainingAfterSecondCut: MoneyInput;
  thirdCutAmount: MoneyInput;
}

export interface ThirdCutResult {
  remainingAfterSecondCut: string;
  thirdCutAmount: string;
  employeeCashAmount: string;
  /** True when the third cut exceeds what is left, producing negative cash. */
  isOverdrawn: boolean;
}

export function calculateThirdCutAndEmployeeCash(input: ThirdCutInput): ThirdCutResult {
  const remaining = dec(input.remainingAfterSecondCut);
  const thirdCut = dec(input.thirdCutAmount);
  const employeeCash = remaining.minus(thirdCut);

  return {
    remainingAfterSecondCut: toMoney(remaining),
    thirdCutAmount: toMoney(thirdCut),
    employeeCashAmount: toMoney(employeeCash),
    isOverdrawn: employeeCash.isNegative(),
  };
}

/** Convenience: the full waterfall in one call, for the account period view. */
export function calculateAccountWaterfall(
  input: SequentialCutInput & { thirdCutAmount: MoneyInput },
): SequentialCutResult & ThirdCutResult {
  const cuts = calculateSequentialCuts(input);
  const third = calculateThirdCutAndEmployeeCash({
    remainingAfterSecondCut: cuts.remainingAfterSecondCut,
    thirdCutAmount: input.thirdCutAmount,
  });
  return { ...cuts, ...third };
}

function assertFraction(value: Decimal, label: string): void {
  if (value.isNegative() || value.greaterThan(1)) {
    throw new RangeError(
      `${label} must be a decimal fraction between 0 and 1 (received ${value.toString()})`,
    );
  }
}

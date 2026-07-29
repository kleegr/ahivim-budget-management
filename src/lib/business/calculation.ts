import { dec, toMoney, toHours, type MoneyInput } from "@/lib/money";

/**
 * THE CALCULATION WORKFLOW (pure, decimal-safe) — the `Calculation` tab.
 *
 * Reproduces the spreadsheet's budget math transparently: annual gross ->
 * monthly gross -> first cut -> second (sequential) cut -> clock/manual
 * adjustment -> final gross -> final net -> "After All". EVERY step is returned
 * as a labelled line so the UI can show exactly how a number was reached and
 * never present a bare final figure. No floating point: all money is decimal.js.
 *
 * The agency-vs-employee split is kept separate: agency gross uses the agency
 * rate, the internal amount uses the internal (employee) rate, and the agency
 * additional amount is the difference — never merged into one number.
 */

export interface CalculationInput {
  /** Authorized hours for the period (annual, unless `basis` is monthly-derived). */
  annualAuthorizedHours?: MoneyInput | null;
  /** If the authorization is dollar-based, this overrides hours x rate. */
  annualAuthorizedDollars?: MoneyInput | null;
  /** The program's internal (employee) rate. */
  programRate: MoneyInput;
  /** An individual-specific internal rate override, when allowed. */
  individualRateOverride?: MoneyInput | null;
  /** The agency (funding) rate, for the agency-vs-employee split. */
  agencyRate?: MoneyInput | null;
  /** Explicit per-hour agency additional; if absent it is (agencyRate - effectiveRate). */
  agencyAdditionalPerHour?: MoneyInput | null;
  /** Months the annual gross divides into (default 12). */
  months?: number;
  /** Which base the cuts apply to. */
  basis?: "annual" | "monthly";
  cut1Percent?: MoneyInput | null;
  cut2Percent?: MoneyInput | null;
  /** 'sequential' applies cut 2 to the post-cut-1 amount; 'parallel' to the base. */
  cutOrder?: "sequential" | "parallel";
  /** Clock or manual adjustment (signed) applied after the cuts. */
  clockAdjustment?: MoneyInput | null;
  /** Signed adjustment from final gross to final net. */
  netAdjustment?: MoneyInput | null;
  /** Signed adjustment from final net to the "After All" amount. */
  afterAllAdjustment?: MoneyInput | null;
}

export interface CalcStep {
  key: string;
  label: string;
  /** Human-readable formula, e.g. "1,000.00 h x 17.0000". */
  formula: string;
  /** The resulting value as a money string. */
  value: string;
}

export interface CalculationResult {
  effectiveRate: string;
  annualGross: string;
  monthlyGross: string;
  base: string;
  cut1Percent: string;
  cut1Amount: string;
  afterCut1: string;
  cut2Percent: string;
  cut2Amount: string;
  afterCut2: string;
  clockAdjustment: string;
  finalGross: string;
  finalNet: string;
  afterAll: string;
  /** Agency-vs-employee split (per the whole base, not per hour). */
  agencyGross: string | null;
  internalAmount: string;
  agencyAdditional: string | null;
  /** Ordered, labelled steps — the transparency the spreadsheet lacks. */
  steps: CalcStep[];
}

function pct(v: MoneyInput | null | undefined) {
  // Accept "0.1", "10" (=> treat >1 as a percentage number), or "10%".
  if (v === null || v === undefined || v === "") return dec(0);
  const raw = String(v).trim().replace(/%$/, "");
  const d = dec(raw);
  return d.gt(1) ? d.dividedBy(100) : d;
}
const fmtPct = (d: ReturnType<typeof dec>) => `${d.times(100).toDecimalPlaces(4).toString()}%`;

/**
 * Run the full calculation. Deterministic and side-effect-free, so the same
 * inputs always reproduce the same audited figures.
 */
export function computeCalculation(input: CalculationInput): CalculationResult {
  const months = Math.max(1, Math.floor(input.months ?? 12));
  const programRate = dec(input.programRate ?? 0);
  const hasOverride =
    input.individualRateOverride !== null &&
    input.individualRateOverride !== undefined &&
    input.individualRateOverride !== "";
  const effectiveRate = hasOverride ? dec(input.individualRateOverride as MoneyInput) : programRate;

  const hasHours =
    input.annualAuthorizedHours !== null &&
    input.annualAuthorizedHours !== undefined &&
    input.annualAuthorizedHours !== "";
  const hours = hasHours ? dec(input.annualAuthorizedHours as MoneyInput) : dec(0);
  const hasDollars =
    input.annualAuthorizedDollars !== null &&
    input.annualAuthorizedDollars !== undefined &&
    input.annualAuthorizedDollars !== "";

  const steps: CalcStep[] = [];

  // 1. Annual gross.
  const annualGross = hasDollars ? dec(input.annualAuthorizedDollars as MoneyInput) : hours.times(effectiveRate);
  steps.push({
    key: "annual_gross",
    label: "Annual gross",
    formula: hasDollars
      ? `authorized dollars = ${toMoney(annualGross)}`
      : `${toHours(hours)} h x ${toMoney(effectiveRate)}`,
    value: toMoney(annualGross),
  });

  // 2. Monthly gross.
  const monthlyGross = annualGross.dividedBy(months);
  steps.push({
    key: "monthly_gross",
    label: "Monthly gross",
    formula: `${toMoney(annualGross)} / ${months}`,
    value: toMoney(monthlyGross),
  });

  const basis = input.basis === "monthly" ? "monthly" : "annual";
  const base = basis === "monthly" ? monthlyGross : annualGross;

  // 3. First cut.
  const cut1 = pct(input.cut1Percent);
  const cut1Amount = base.times(cut1);
  const afterCut1 = base.minus(cut1Amount);
  steps.push({
    key: "cut1",
    label: "First cut",
    formula: `${toMoney(base)} x ${fmtPct(cut1)} = ${toMoney(cut1Amount)} cut -> ${toMoney(afterCut1)}`,
    value: toMoney(afterCut1),
  });

  // 4. Second cut (sequential by default: applied to the post-cut-1 amount).
  const cut2 = pct(input.cut2Percent);
  const cut2Base = input.cutOrder === "parallel" ? base : afterCut1;
  const cut2Amount = cut2Base.times(cut2);
  const afterCut2 = afterCut1.minus(cut2Amount);
  steps.push({
    key: "cut2",
    label: `Second cut (${input.cutOrder === "parallel" ? "parallel" : "sequential"})`,
    formula: `${toMoney(cut2Base)} x ${fmtPct(cut2)} = ${toMoney(cut2Amount)} cut -> ${toMoney(afterCut2)}`,
    value: toMoney(afterCut2),
  });

  // 5. Clock / manual adjustment.
  const clock = dec(input.clockAdjustment ?? 0);
  const finalGross = afterCut2.plus(clock);
  steps.push({
    key: "final_gross",
    label: "Final gross (after adjustments)",
    formula: `${toMoney(afterCut2)} ${clock.isNegative() ? "-" : "+"} ${toMoney(clock.abs())} adjustment`,
    value: toMoney(finalGross),
  });

  // 6. Final net.
  const netAdj = dec(input.netAdjustment ?? 0);
  const finalNet = finalGross.plus(netAdj);
  steps.push({
    key: "final_net",
    label: "Final net",
    formula: netAdj.isZero() ? `= final gross` : `${toMoney(finalGross)} ${netAdj.isNegative() ? "-" : "+"} ${toMoney(netAdj.abs())}`,
    value: toMoney(finalNet),
  });

  // 7. After All.
  const afterAllAdj = dec(input.afterAllAdjustment ?? 0);
  const afterAll = finalNet.plus(afterAllAdj);
  steps.push({
    key: "after_all",
    label: "After All",
    formula: afterAllAdj.isZero() ? `= final net` : `${toMoney(finalNet)} ${afterAllAdj.isNegative() ? "-" : "+"} ${toMoney(afterAllAdj.abs())}`,
    value: toMoney(afterAll),
  });

  // Agency-vs-employee split (over the same base).
  const hasAgency = input.agencyRate !== null && input.agencyRate !== undefined && input.agencyRate !== "";
  let agencyGross: string | null = null;
  let agencyAdditional: string | null = null;
  const internalAmount = base;
  if (hasHours && (hasAgency || (input.agencyAdditionalPerHour !== null && input.agencyAdditionalPerHour !== undefined && input.agencyAdditionalPerHour !== ""))) {
    const agencyRate = hasAgency ? dec(input.agencyRate as MoneyInput) : effectiveRate;
    const gross = hours.times(agencyRate);
    agencyGross = toMoney(gross);
    const perHourAdditional =
      input.agencyAdditionalPerHour !== null && input.agencyAdditionalPerHour !== undefined && input.agencyAdditionalPerHour !== ""
        ? dec(input.agencyAdditionalPerHour as MoneyInput)
        : agencyRate.minus(effectiveRate);
    agencyAdditional = toMoney(hours.times(perHourAdditional));
    steps.push({
      key: "agency_split",
      label: "Agency vs employee",
      formula: `agency ${toMoney(gross)} = internal ${toMoney(hours.times(effectiveRate))} + additional ${agencyAdditional}`,
      value: agencyGross,
    });
  }

  return {
    effectiveRate: toMoney(effectiveRate),
    annualGross: toMoney(annualGross),
    monthlyGross: toMoney(monthlyGross),
    base: toMoney(base),
    cut1Percent: fmtPct(cut1),
    cut1Amount: toMoney(cut1Amount),
    afterCut1: toMoney(afterCut1),
    cut2Percent: fmtPct(cut2),
    cut2Amount: toMoney(cut2Amount),
    afterCut2: toMoney(afterCut2),
    clockAdjustment: toMoney(clock),
    finalGross: toMoney(finalGross),
    finalNet: toMoney(finalNet),
    afterAll: toMoney(afterAll),
    agencyGross,
    internalAmount: toMoney(internalAmount),
    agencyAdditional,
    steps,
  };
}

/**
 * The agency-vs-employee split for a single delivered/planned amount, given the
 * agency and internal rates. Agency additional = agency - internal; self-hire
 * (no agency rate, or a program that does not convert) has zero additional.
 */
export function agencySplit(input: {
  hours: MoneyInput;
  agencyRate?: MoneyInput | null;
  internalRate: MoneyInput;
  converts?: boolean;
}): { agencyGross: string; internalAmount: string; agencyAdditional: string } {
  const hours = dec(input.hours);
  const internal = hours.times(dec(input.internalRate));
  const hasAgency = input.agencyRate !== null && input.agencyRate !== undefined && input.agencyRate !== "";
  const converts = input.converts !== false; // default: convert unless explicitly self-hire
  if (!hasAgency || !converts) {
    // Self-hire / non-converting: agency == internal, no additional.
    return { agencyGross: toMoney(internal), internalAmount: toMoney(internal), agencyAdditional: toMoney(dec(0)) };
  }
  const agency = hours.times(dec(input.agencyRate as MoneyInput));
  return {
    agencyGross: toMoney(agency),
    internalAmount: toMoney(internal),
    agencyAdditional: toMoney(agency.minus(internal)),
  };
}

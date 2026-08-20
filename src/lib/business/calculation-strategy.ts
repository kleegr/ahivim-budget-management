import { dec, toMoney, formatMoney, formatHours, type MoneyInput, type Decimal } from "@/lib/money";

/**
 * The Calculation-tab formula chain, reproduced exactly and step by step so a
 * number can always be explained rather than taken on faith. Verified against
 * the workbook (e.g. Joel Duestch: 780×21 + 860×38 + 1075×17 + 430×17 = 74,645
 * yearly; ÷12 = 6,220.42 monthly; −23% then −28% = 3,448.60 gross-net; −300
 * clock = 3,148.60 net).
 *
 * Pure and decimal-safe. Internal rates come from the caller (read from the
 * effective-dated program_rate_schedules), never hardcoded here.
 */
export interface StrategyLineInput {
  programLabel: string;
  programId?: string;
  hours: MoneyInput;
  internalRate: MoneyInput; // the EFFECTIVE rate used (override if set, else default)
  isOverride?: boolean;
  defaultRate?: MoneyInput; // the schedule default, for a default-vs-override display
}

export interface StrategyInput {
  lines: StrategyLineInput[];
  monthDivisor?: MoneyInput; // default 12
  cut1Percent?: MoneyInput; // fraction (0.24) or percent (24) — normalised
  cut2Percent?: MoneyInput;
  clockAdjustment?: MoneyInput;
  otherAdjustment?: MoneyInput;
  afterAll?: MoneyInput | null;
}

export interface StrategyStep {
  key: string;
  label: string;
  formula: string;
  value: string; // money string, 4dp
}

export interface StrategyLineGross {
  programLabel: string;
  programId?: string;
  hours: string;
  rate: string; // effective rate
  gross: string;
  isOverride: boolean;
  defaultRate: string;
}

export interface StrategyResult {
  yearlyGross: string;
  monthlyGross: string;
  monthDivisor: string;
  cut1Fraction: string;
  cut1Amount: string;
  afterCut1: string;
  cut2Fraction: string;
  cut2Amount: string;
  grossNet: string; // workbook "Gross Net" (after both cuts)
  clockAdjustment: string;
  otherAdjustment: string;
  net: string; // workbook "Net"
  afterAll: string | null; // manual final figure
  lineGross: StrategyLineGross[];
  steps: StrategyStep[];
}

/** Accept 0.24 or 24 (or "24%") and return a fraction. Values > 1 are percents. */
function toFraction(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") return dec(0);
  const raw = typeof value === "string" ? value.replace("%", "") : value;
  const d = dec(raw);
  return d.abs().greaterThan(1) ? d.dividedBy(100) : d;
}

export function computeStrategy(input: StrategyInput): StrategyResult {
  const divisor = input.monthDivisor != null && dec(input.monthDivisor).greaterThan(0)
    ? dec(input.monthDivisor)
    : dec(12);
  const cut1 = toFraction(input.cut1Percent);
  const cut2 = toFraction(input.cut2Percent);
  const clock = dec(input.clockAdjustment ?? 0);
  const other = dec(input.otherAdjustment ?? 0);

  const lineGross: StrategyLineGross[] = [];
  let yearly = dec(0);
  for (const line of input.lines) {
    const h = dec(line.hours ?? 0);
    const r = dec(line.internalRate ?? 0);
    const g = h.times(r);
    if (h.isZero() && r.isZero()) continue;
    yearly = yearly.plus(g);
    lineGross.push({
      programLabel: line.programLabel,
      programId: line.programId,
      hours: toMoney(h),
      rate: toMoney(r),
      gross: toMoney(g),
      isOverride: line.isOverride === true,
      defaultRate: toMoney(line.defaultRate ?? r),
    });
  }

  const monthly = yearly.dividedBy(divisor);
  const cut1Amount = monthly.times(cut1);
  const afterCut1 = monthly.minus(cut1Amount);
  const cut2Amount = afterCut1.times(cut2);
  const grossNet = afterCut1.minus(cut2Amount);
  const net = grossNet.plus(clock).plus(other);
  const afterAll = input.afterAll == null || input.afterAll === "" ? null : dec(input.afterAll);

  const pct = (f: Decimal) => `${f.times(100).toDecimalPlaces(2).toString()}%`;
  const yearlyFormula =
    lineGross.length > 0
      ? lineGross.map((l) => `${formatHours(l.hours)}h × ${formatMoney(l.rate)}`).join("  +  ")
      : "no program hours";

  const steps: StrategyStep[] = [
    { key: "yearly_gross", label: "Yearly gross", formula: yearlyFormula, value: toMoney(yearly) },
    { key: "monthly_gross", label: "Monthly gross", formula: `${formatMoney(yearly)} ÷ ${divisor.toString()}`, value: toMoney(monthly) },
    { key: "cut1", label: "First cut", formula: `${formatMoney(monthly)} × ${pct(cut1)}`, value: toMoney(cut1Amount) },
    { key: "after_cut1", label: "After first cut", formula: `${formatMoney(monthly)} − ${formatMoney(cut1Amount)}`, value: toMoney(afterCut1) },
    { key: "cut2", label: "Second cut", formula: `${formatMoney(afterCut1)} × ${pct(cut2)}`, value: toMoney(cut2Amount) },
    { key: "gross_net", label: "Gross net (after both cuts)", formula: `${formatMoney(afterCut1)} − ${formatMoney(cut2Amount)}`, value: toMoney(grossNet) },
    { key: "net", label: "Net (after adjustments)", formula: `${formatMoney(grossNet)} + ${formatMoney(clock)} clock + ${formatMoney(other)} adj`, value: toMoney(net) },
    { key: "after_all", label: "After All (final, entered)", formula: afterAll == null ? "not set" : "final configured figure", value: afterAll == null ? "" : toMoney(afterAll) },
  ];

  return {
    yearlyGross: toMoney(yearly),
    monthlyGross: toMoney(monthly),
    monthDivisor: divisor.toString(),
    cut1Fraction: cut1.toString(),
    cut1Amount: toMoney(cut1Amount),
    afterCut1: toMoney(afterCut1),
    cut2Fraction: cut2.toString(),
    cut2Amount: toMoney(cut2Amount),
    grossNet: toMoney(grossNet),
    clockAdjustment: toMoney(clock),
    otherAdjustment: toMoney(other),
    net: toMoney(net),
    afterAll: afterAll == null ? null : toMoney(afterAll),
    lineGross,
    steps,
  };
}

/**
 * Derive the 12-month budget period from a renewal date alone:
 * start = renewal − 12 months, end = renewal. (Renewal 2023-01-01 ⇒
 * 2022-01-01 → 2023-01-01.) Returns ISO date strings, or nulls if no renewal.
 */
export function derivePeriodFromRenewal(renewalDate: string | null): {
  start: string | null;
  end: string | null;
} {
  if (!renewalDate) return { start: null, end: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(renewalDate);
  if (!m) return { start: null, end: renewalDate };
  const year = Number(m[1]);
  const start = `${year - 1}-${m[2]}-${m[3]}`;
  return { start, end: `${m[1]}-${m[2]}-${m[3]}` };
}

/**
 * The budget year we are CURRENTLY inside, given a renewal date that repeats
 * every year. A renewal is the first day of a new 12-month budget, so the
 * current period is [effectiveRenewal − 12 months, effectiveRenewal].
 *
 * For an ACTIVE account the renewal auto-rolls forward: we pick the first
 * anniversary strictly after today, so a stored date in the past
 * (e.g. 2026-02-01) automatically becomes 2027-02-01 — the account never reads
 * "expired", it just moves to the next year, exactly like the paper rollover.
 *
 * For an INACTIVE account nothing rolls: the stored date is used as-is (so an
 * inactive person can legitimately show a past, expired period).
 */
export function currentBudgetPeriod(
  renewalDate: string | null,
  active: boolean,
  asOf?: string,
): { start: string | null; end: string | null; effectiveRenewal: string | null; rolled: boolean } {
  if (!renewalDate) return { start: null, end: null, effectiveRenewal: null, rolled: false };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(renewalDate);
  if (!m) return { start: null, end: renewalDate, effectiveRenewal: renewalDate, rolled: false };
  const baseYear = Number(m[1]);
  const monthDay = `${m[2]}-${m[3]}`;
  const at = (y: number) => `${String(y).padStart(4, "0")}-${monthDay}`;
  if (!active) {
    return { start: at(baseYear - 1), end: at(baseYear), effectiveRenewal: at(baseYear), rolled: false };
  }
  const today = (asOf ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  let endYear = baseYear;
  // Smallest anniversary strictly after today (renewal day itself opens the new year).
  while (at(endYear) <= today) endYear++;
  return { start: at(endYear - 1), end: at(endYear), effectiveRenewal: at(endYear), rolled: endYear !== baseYear };
}

/**
 * Programs whose budget year is ALWAYS the calendar year (January 1 → January 1),
 * regardless of the individual's own renewal date. Day Hab and Supplemental Group
 * Day Hab are billed on a January–January cycle by rule, so every used / left /
 * pace calculation for them must use the calendar window — never the individual's
 * renewal. This one set is the source of truth; both the read model and the SQL
 * board reference it (the SQL mirrors the same codes).
 */
export const CALENDAR_YEAR_PROGRAM_CODES: ReadonlySet<string> = new Set(["DAY_HAB", "SUPP_GROUP_DAY_HAB"]);

export function isCalendarYearProgram(code: string | null | undefined): boolean {
  return !!code && CALENDAR_YEAR_PROGRAM_CODES.has(code);
}

/**
 * Programs billed as GROUP sessions: one session serves several people at a
 * COMBINED rate, so a group row's transaction hours are the whole session's
 * hours, not this individual's real hours. Day Hab and Supplemental Group Day Hab
 * are billed this way. (Same two programs as the calendar-year rule, kept as a
 * separate set so the two concepts can diverge later without surprise.)
 */
export const GROUP_SESSION_PROGRAM_CODES: ReadonlySet<string> = new Set(["DAY_HAB", "SUPP_GROUP_DAY_HAB"]);

export function isGroupSessionProgram(code: string | null | undefined): boolean {
  return !!code && GROUP_SESSION_PROGRAM_CODES.has(code);
}

/**
 * The real hours billed for a program. For a normal program this is just the
 * clock hours on the transactions. For a GROUP-session program the raw hours are
 * a combined-session figure and mean nothing per person, so we back the hours out
 * of the money at the plan's OWN hourly rate instead:
 *
 *     hours = internal amount / budget rate      (e.g. $10,000 / $17 = 588.24 h)
 *
 * The rate is the internal per-hour rate set in the budget (override if present,
 * else the program's default). If there is no usable rate we fall back to the raw
 * hours rather than divide by zero. Returns a decimal string.
 */
export function effectiveBilledHours(
  code: string | null | undefined,
  rawHours: MoneyInput,
  internalAmount: MoneyInput,
  budgetRate: MoneyInput | null | undefined,
): string {
  if (!isGroupSessionProgram(code)) return dec(rawHours ?? 0).toString();
  const rate = dec(budgetRate ?? 0);
  if (!rate.greaterThan(0)) return dec(rawHours ?? 0).toString();
  return dec(internalAmount ?? 0).dividedBy(rate).toString();
}

/**
 * The budget period for ONE program line. Day Hab / Supplemental always use the
 * current calendar year (they never expire and never follow the person's renewal);
 * every other program follows the individual's own renewal via currentBudgetPeriod.
 */
export function programBudgetPeriod(
  code: string | null | undefined,
  individualRenewal: string | null,
  active: boolean,
  asOf?: string,
): { start: string | null; end: string | null; effectiveRenewal: string | null; rolled: boolean } {
  if (isCalendarYearProgram(code)) return currentBudgetPeriod("2000-01-01", true, asOf); // the current Jan→Jan year
  return currentBudgetPeriod(individualRenewal, active, asOf);
}

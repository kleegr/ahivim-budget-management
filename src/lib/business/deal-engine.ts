import { dec, Decimal, MONEY_SCALE, toMoney } from "@/lib/money";

/**
 * The deal engine accepts and returns numeric strings. This keeps database
 * numeric values exact at every boundary and makes accidental float math a
 * type error for callers.
 */
export type NumericString = string;

export const DEAL_FORMULAS = {
  agencySpread: "billed amount - base amount",
  agencyCut: "base amount * agency cut fraction",
  agencyEmployeePayable: "base amount - agency cut",
  directGiveback: "check net * give-back fraction",
  directEmployeeKeeps: "check net - employee owes agency",
  withholdingDisplay: "check gross - check net",
} as const;

export interface ReconciliationInvariant {
  formula: string;
  expected: NumericString;
  actual: NumericString;
  /** actual - expected; exactly 0.0000 when the invariant holds. */
  difference: NumericString;
  reconciles: boolean;
}

export interface AgencyRoutedDeal {
  /** A decimal fraction: "0.20" means 20%. */
  agencyCutFraction: NumericString;
}

/**
 * One agency-routed transaction. The deal is evaluated per transaction so its
 * rounded result can be settled and audited without redistributing rounding
 * differences across unrelated rows.
 */
export interface AgencyRoutedTransactionInput {
  flow: "agency_routed";
  transactionId: string;
  billedAmount: NumericString;
  baseAmount: NumericString;
  deal: AgencyRoutedDeal;
}

export interface AgencyRoutedTransactionResult {
  flow: "agency_routed";
  transactionId: string;
  billedAmount: NumericString;
  baseAmount: NumericString;
  /** Billed minus base. It is outside the deal and is not clamped at zero. */
  agencySpread: NumericString;
  /** The agency's percentage share of base. */
  agencyCut: NumericString;
  /** What the agency must pay the employee from this transaction. */
  employeePayable: NumericString;
  /** Agency spread plus agency cut; useful for display, never a deal basis. */
  agencyKeepsTotal: NumericString;
  reconciliations: readonly ReconciliationInvariant[];
}

export type DirectEmployeeDeal =
  | { mode: "keep_all" }
  | { mode: "giveback_percent"; givebackFraction: NumericString }
  | { mode: "giveback_all" };

/**
 * Direct/self-hire math is intentionally check-level. A repeated total_net_pay
 * value from transaction rows must be collapsed by the caller into exactly one
 * input per check. checkId should therefore be a stable unique check identity
 * (and may be a caller-built composite when check numbers are not globally
 * unique).
 */
export interface DirectEmployeeCheckInput {
  flow: "direct_employee";
  checkId: string;
  checkNet: NumericString;
  /** Optional display fact. It never participates in the deal calculation. */
  checkGross?: NumericString | null;
  deal: DirectEmployeeDeal;
}

export interface DirectEmployeeCheckResult {
  flow: "direct_employee";
  checkId: string;
  mode: DirectEmployeeDeal["mode"];
  checkNet: NumericString;
  checkGross: NumericString | null;
  /** Gross minus net, for display only. It never participates in deal math. */
  withholding: NumericString | null;
  employeeKeeps: NumericString;
  employeeOwesAgency: NumericString;
  reconciliations: readonly ReconciliationInvariant[];
}

export interface EmployeeDealAggregationInput {
  agencyRoutedTransactions: readonly AgencyRoutedTransactionInput[];
  /** Exactly one entry per direct-pay check; duplicate checkIds are rejected. */
  directEmployeeChecks: readonly DirectEmployeeCheckInput[];
}

export interface AgencyRoutedTotals {
  transactionCount: number;
  billedAmount: NumericString;
  baseAmount: NumericString;
  agencySpread: NumericString;
  agencyCut: NumericString;
  employeePayable: NumericString;
  agencyKeepsTotal: NumericString;
}

export interface DirectEmployeeTotals {
  checkCount: number;
  checkNet: NumericString;
  employeeKeeps: NumericString;
  employeeOwesAgency: NumericString;
  /** Sum over checks that supplied checkGross; partial coverage is explicit. */
  knownCheckGross: NumericString;
  knownWithholding: NumericString;
  checksWithGross: number;
}

export interface EmployeeDealAggregationResult {
  agencyRoutedTransactions: readonly AgencyRoutedTransactionResult[];
  directEmployeeChecks: readonly DirectEmployeeCheckResult[];
  agencyRouted: AgencyRoutedTotals;
  directEmployee: DirectEmployeeTotals;
  /** Keep the two directions separate; settlement must not silently net them. */
  obligations: {
    agencyOwesEmployees: NumericString;
    employeesOweAgency: NumericString;
  };
  reconciliations: readonly ReconciliationInvariant[];
}

function parseMoney(value: NumericString, label: string): Decimal {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty numeric string`);
  }
  const rounded = dec(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? dec(0) : rounded;
}

function parseFraction(value: NumericString, label: string): Decimal {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty numeric string`);
  }
  const fraction = dec(value);
  if (fraction.isNegative() || fraction.gt(1)) {
    throw new RangeError(`${label} must be between 0 and 1 inclusive`);
  }
  return fraction;
}

function roundMoney(value: Decimal): Decimal {
  const rounded = value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? dec(0) : rounded;
}

function money(value: Decimal): NumericString {
  return toMoney(value.isZero() ? dec(0) : value);
}

function invariant(
  formula: string,
  expected: Decimal,
  actualParts: readonly Decimal[],
): ReconciliationInvariant {
  const actual = actualParts.reduce((sum, part) => sum.plus(part), dec(0));
  const difference = actual.minus(expected);
  return {
    formula,
    expected: money(expected),
    actual: money(actual),
    difference: money(difference),
    reconciles: difference.isZero(),
  };
}

export function calculateAgencyRoutedTransaction(
  input: AgencyRoutedTransactionInput,
): AgencyRoutedTransactionResult {
  if (input.transactionId.trim() === "") {
    throw new TypeError("transactionId must be non-empty");
  }

  const billed = parseMoney(input.billedAmount, "billedAmount");
  const base = parseMoney(input.baseAmount, "baseAmount");
  const fraction = parseFraction(input.deal.agencyCutFraction, "agencyCutFraction");

  // Round the agency cut once, then assign the exact residual to the employee.
  // This preserves base = cut + payable at the persisted four-decimal scale.
  const agencyCut = roundMoney(base.times(fraction));
  const employeePayable = base.minus(agencyCut);
  const agencySpread = billed.minus(base);
  const agencyKeepsTotal = agencySpread.plus(agencyCut);

  return {
    flow: "agency_routed",
    transactionId: input.transactionId,
    billedAmount: money(billed),
    baseAmount: money(base),
    agencySpread: money(agencySpread),
    agencyCut: money(agencyCut),
    employeePayable: money(employeePayable),
    agencyKeepsTotal: money(agencyKeepsTotal),
    reconciliations: [
      invariant("base amount = agency cut + employee payable", base, [agencyCut, employeePayable]),
      invariant("billed amount = agency spread + agency cut + employee payable", billed, [
        agencySpread,
        agencyCut,
        employeePayable,
      ]),
    ],
  };
}

export function calculateDirectEmployeeCheck(
  input: DirectEmployeeCheckInput,
): DirectEmployeeCheckResult {
  if (input.checkId.trim() === "") {
    throw new TypeError("checkId must be non-empty");
  }

  const checkNet = parseMoney(input.checkNet, "checkNet");
  const checkGross = input.checkGross == null ? null : parseMoney(input.checkGross, "checkGross");

  let employeeOwesAgency: Decimal;
  switch (input.deal.mode) {
    case "keep_all":
      employeeOwesAgency = dec(0);
      break;
    case "giveback_all":
      employeeOwesAgency = checkNet;
      break;
    case "giveback_percent": {
      const fraction = parseFraction(input.deal.givebackFraction, "givebackFraction");
      employeeOwesAgency = roundMoney(checkNet.times(fraction));
      break;
    }
  }

  // The residual is authoritative so check-net conservation remains exact.
  const employeeKeeps = checkNet.minus(employeeOwesAgency);
  const withholding = checkGross?.minus(checkNet) ?? null;

  return {
    flow: "direct_employee",
    checkId: input.checkId,
    mode: input.deal.mode,
    checkNet: money(checkNet),
    checkGross: checkGross ? money(checkGross) : null,
    withholding: withholding ? money(withholding) : null,
    employeeKeeps: money(employeeKeeps),
    employeeOwesAgency: money(employeeOwesAgency),
    reconciliations: [
      invariant("check net = employee keeps + employee owes agency", checkNet, [
        employeeKeeps,
        employeeOwesAgency,
      ]),
    ],
  };
}

function assertUniqueIds(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new RangeError(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

/**
 * Calculate and total a mixed employee ledger. Agency rows are rounded per
 * transaction. Direct-pay net is supplied once per check and never rebuilt
 * from transaction gross/base rows.
 */
export function aggregateEmployeeDeals(
  input: EmployeeDealAggregationInput,
): EmployeeDealAggregationResult {
  assertUniqueIds(
    input.agencyRoutedTransactions.map((transaction) => transaction.transactionId),
    "transactionId",
  );
  assertUniqueIds(
    input.directEmployeeChecks.map((check) => check.checkId),
    "checkId",
  );

  const agencyResults = input.agencyRoutedTransactions.map(calculateAgencyRoutedTransaction);
  const directResults = input.directEmployeeChecks.map(calculateDirectEmployeeCheck);

  const routed = agencyResults.reduce(
    (totals, result) => ({
      billed: totals.billed.plus(result.billedAmount),
      base: totals.base.plus(result.baseAmount),
      spread: totals.spread.plus(result.agencySpread),
      cut: totals.cut.plus(result.agencyCut),
      payable: totals.payable.plus(result.employeePayable),
      keeps: totals.keeps.plus(result.agencyKeepsTotal),
    }),
    {
      billed: dec(0),
      base: dec(0),
      spread: dec(0),
      cut: dec(0),
      payable: dec(0),
      keeps: dec(0),
    },
  );

  const direct = directResults.reduce(
    (totals, result) => {
      const hasGross = result.checkGross !== null && result.withholding !== null;
      return {
        net: totals.net.plus(result.checkNet),
        keeps: totals.keeps.plus(result.employeeKeeps),
        owed: totals.owed.plus(result.employeeOwesAgency),
        knownGross: hasGross ? totals.knownGross.plus(result.checkGross!) : totals.knownGross,
        knownWithholding: hasGross
          ? totals.knownWithholding.plus(result.withholding!)
          : totals.knownWithholding,
        checksWithGross: totals.checksWithGross + (hasGross ? 1 : 0),
      };
    },
    {
      net: dec(0),
      keeps: dec(0),
      owed: dec(0),
      knownGross: dec(0),
      knownWithholding: dec(0),
      checksWithGross: 0,
    },
  );

  const reconciliations = [
    invariant("aggregate base amount = aggregate agency cut + aggregate employee payable", routed.base, [
      routed.cut,
      routed.payable,
    ]),
    invariant(
      "aggregate billed amount = aggregate agency spread + aggregate agency cut + aggregate employee payable",
      routed.billed,
      [routed.spread, routed.cut, routed.payable],
    ),
    invariant("aggregate check net = aggregate employee keeps + aggregate employee owes agency", direct.net, [
      direct.keeps,
      direct.owed,
    ]),
  ];

  return {
    agencyRoutedTransactions: agencyResults,
    directEmployeeChecks: directResults,
    agencyRouted: {
      transactionCount: agencyResults.length,
      billedAmount: money(routed.billed),
      baseAmount: money(routed.base),
      agencySpread: money(routed.spread),
      agencyCut: money(routed.cut),
      employeePayable: money(routed.payable),
      agencyKeepsTotal: money(routed.keeps),
    },
    directEmployee: {
      checkCount: directResults.length,
      checkNet: money(direct.net),
      employeeKeeps: money(direct.keeps),
      employeeOwesAgency: money(direct.owed),
      knownCheckGross: money(direct.knownGross),
      knownWithholding: money(direct.knownWithholding),
      checksWithGross: direct.checksWithGross,
    },
    obligations: {
      agencyOwesEmployees: money(routed.payable),
      employeesOweAgency: money(direct.owed),
    },
    reconciliations,
  };
}

import { agencyMonth } from "@/lib/business/agency-time";
import type { PgLikePool } from "@/lib/import/commit";
import { dec, toMoney } from "@/lib/money";
import {
  listManualIncomeEntries,
  type ManualIncomeEntry,
} from "@/lib/manage/agency-financials";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type PayRuleSource = "person_rule" | "employee_default" | "missing";
export type ClassSplitSource = "configured" | "full_agency_default" | "missing";

export interface AgencyFinancialOption {
  id: string;
  label: string;
  code?: string;
}

export interface AgencyFinancialOptions {
  individuals: AgencyFinancialOption[];
  employees: AgencyFinancialOption[];
  programs: AgencyFinancialOption[];
}

export interface AgencyTransactionActual {
  id: string;
  serviceDate: string;
  individualId: string | null;
  individualName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  programName: string | null;
  paymentRecipient: string;
  grossAmount: string | null;
  baseAmount: string | null;
  employeeSharePercent: string | null;
  employeeExpense: string | null;
  payRuleSource: PayRuleSource | null;
}

export interface DirectPayCheckActual {
  id: string;
  serviceDate: string;
  employeeId: string;
  employeeName: string;
  checkNumber: string | null;
  grossAmount: string | null;
  netAmount: string;
  taxes: string | null;
  employeeKeeps: string | null;
  employeeOwesAgency: string | null;
  dealLabel: string | null;
}

export interface MonthlySetAsideActual {
  strategyId: string;
  individualId: string;
  individualName: string;
  setupName: string;
  firstCutPercent: string;
  secondCutPercent: string;
  approvedMonthlyFinal: string | null;
}

export interface ClassInvoiceActual {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  individualId: string;
  individualName: string;
  programId: string | null;
  programName: string | null;
  grossAmount: string;
  agencySharePercent: string | null;
  agencyAmount: string | null;
  individualExpense: string | null;
  splitSource: ClassSplitSource;
}

export interface AgencyFinancialCoverage {
  transactionsMissingAmount: number;
  agencyTransactionsMissingBase: number;
  agencyTransactionsMissingPayRule: number;
  directChecksMissingGross: number;
  directChecksGrossBelowNet: number;
  directChecksMissingDeal: number;
  classInvoicesMissingProgram: number;
  classInvoicesMissingSplit: number;
  setupsMissingApprovedFinal: number;
  unknownPaymentRecipients: number;
}

export interface AgencyFinancialReport {
  month: string;
  periodStart: string;
  periodEnd: string;
  transactions: AgencyTransactionActual[];
  directChecks: DirectPayCheckActual[];
  setAsides: MonthlySetAsideActual[];
  classInvoices: ClassInvoiceActual[];
  manualIncome: ManualIncomeEntry[];
  totals: {
    income: {
      transactions: string;
      classes: string;
      manual: string;
      total: string;
    };
    expenses: {
      approvedSetAsides: string;
      taxes: string;
      directEmployeeKeeps: string;
      agencyRoutedEmployeeShare: string;
      classIndividualShare: string;
      manualIndividualShare: string;
      total: string;
    };
    agencyResult: string;
  };
  coverage: AgencyFinancialCoverage;
}

interface TransactionRow {
  id: string;
  service_date: string;
  individual_id: string | null;
  individual_name: string | null;
  employee_id: string | null;
  employee_name: string | null;
  program_name: string | null;
  payment_recipient: string;
  gross_amount: string | null;
  base_amount: string | null;
  person_share_percent: string | null;
  employee_deal_id: string | null;
  agency_cut_percent: string | null;
}

interface CheckRow {
  id: string;
  service_date: string;
  employee_id: string;
  employee_name: string;
  check_number: string | null;
  actual_gross: string | null;
  actual_net: string;
  direct_rule: "keep_all" | "giveback_percent" | "giveback_all" | null;
  direct_percent: string | null;
}

interface SetAsideRow {
  strategy_id: string;
  individual_id: string;
  individual_name: string;
  setup_name: string;
  cut1_percent: string;
  cut2_percent: string;
  approved_final: string | null;
}

interface ClassInvoiceRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  individual_id: string;
  individual_name: string;
  program_id: string | null;
  program_name: string | null;
  total_amount: string;
  agency_share_percent: string | null;
  custom_split_required: boolean;
}

export function normalizeAgencyFinancialMonth(value?: string | null): string {
  return value && MONTH.test(value) ? value : agencyMonth();
}

export function agencyFinancialMonthRange(value?: string | null): {
  month: string;
  start: string;
  endExclusive: string;
  endInclusive: string;
} {
  const month = normalizeAgencyFinancialMonth(value);
  const [year, part] = month.split("-").map(Number);
  const endExclusive = new Date(Date.UTC(year!, part!, 1)).toISOString().slice(0, 10);
  const endInclusiveDate = new Date(`${endExclusive}T00:00:00Z`);
  endInclusiveDate.setUTCDate(endInclusiveDate.getUTCDate() - 1);
  return {
    month,
    start: `${month}-01`,
    endExclusive,
    endInclusive: endInclusiveDate.toISOString().slice(0, 10),
  };
}

export function agencyRoutedEmployeeShare(input: {
  baseAmount: string | null;
  personSharePercent: string | null;
  employeeAgencyCutPercent: string | null;
}): { amount: string | null; percent: string | null; source: PayRuleSource } {
  const percent = input.personSharePercent ?? (
    input.employeeAgencyCutPercent === null
      ? null
      : dec(1).minus(input.employeeAgencyCutPercent).toFixed(6)
  );
  const source: PayRuleSource = input.personSharePercent !== null
    ? "person_rule"
    : input.employeeAgencyCutPercent !== null
      ? "employee_default"
      : "missing";
  if (input.baseAmount === null || percent === null) return { amount: null, percent, source };
  return { amount: toMoney(dec(input.baseAmount).times(percent)), percent, source };
}

export function directPayCheckAmounts(input: {
  grossAmount: string | null;
  netAmount: string;
  directRule: CheckRow["direct_rule"];
  directPercent: string | null;
}): {
  taxes: string | null;
  employeeKeeps: string | null;
  employeeOwesAgency: string | null;
} {
  const net = dec(input.netAmount);
  const taxes = input.grossAmount === null || dec(input.grossAmount).lessThan(net)
    ? null
    : toMoney(dec(input.grossAmount).minus(net));
  if (input.directRule === null) {
    return { taxes, employeeKeeps: null, employeeOwesAgency: null };
  }
  const owed = input.directRule === "giveback_all"
    ? net
    : input.directRule === "giveback_percent"
      ? dec(toMoney(net.times(input.directPercent ?? "0")))
      : dec(0);
  return {
    taxes,
    employeeKeeps: toMoney(net.minus(owed)),
    employeeOwesAgency: toMoney(owed),
  };
}

export function classInvoiceSplit(input: {
  grossAmount: string;
  agencySharePercent: string | null;
  customSplitRequired: boolean;
}): {
  agencySharePercent: string | null;
  agencyAmount: string | null;
  individualExpense: string | null;
  source: ClassSplitSource;
} {
  const percent = input.agencySharePercent ?? (input.customSplitRequired ? null : "1.000000");
  if (percent === null) {
    return { agencySharePercent: null, agencyAmount: null, individualExpense: null, source: "missing" };
  }
  const agencyAmount = toMoney(dec(input.grossAmount).times(percent));
  return {
    agencySharePercent: percent,
    agencyAmount,
    individualExpense: toMoney(dec(input.grossAmount).minus(agencyAmount)),
    source: input.agencySharePercent === null ? "full_agency_default" : "configured",
  };
}

export function approvedMonthlySetAside(value: string | null): string | null {
  return value === null ? null : toMoney(dec(value).abs());
}

function directDealLabel(row: CheckRow): string | null {
  if (row.direct_rule === null) return null;
  if (row.direct_rule === "giveback_all") return "Employee returns all net";
  if (row.direct_rule === "giveback_percent") {
    return `Employee returns ${dec(row.direct_percent ?? 0).times(100).toDecimalPlaces(2).toString()}% of net`;
  }
  return "Employee keeps all net";
}

export async function listAgencyFinancialOptions(pool: PgLikePool): Promise<AgencyFinancialOptions> {
  const [individuals, employees, programs] = await Promise.all([
    pool.query<{ id: string; label: string }>(
      `SELECT id, COALESCE(display_name, normalized_name) AS label
         FROM individuals
        WHERE status <> 'archived' AND merged_into_id IS NULL
        ORDER BY label`,
    ),
    pool.query<{ id: string; label: string }>(
      `SELECT id, COALESCE(display_name, normalized_name) AS label
         FROM employees
        WHERE status <> 'archived' AND merged_into_id IS NULL
        ORDER BY label`,
    ),
    pool.query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM programs WHERE is_active ORDER BY name, code`,
    ),
  ]);
  return {
    individuals: individuals.rows,
    employees: employees.rows,
    programs: programs.rows.map((row) => ({ id: row.id, code: row.code, label: row.name })),
  };
}

export async function getAgencyFinancialReport(
  pool: PgLikePool,
  requestedMonth?: string | null,
): Promise<AgencyFinancialReport> {
  const range = agencyFinancialMonthRange(requestedMonth);
  const canonicalTransactionDate = "canonical_service_date(t.period_begin, t.check_date, t.period_end)";
  const canonicalCheckDate = "canonical_service_date(check_fact.period_begin, check_fact.check_date, check_fact.period_end)";

  const [transactionResult, checkResult, setAsideResult, classResult, manualIncome] = await Promise.all([
    pool.query<TransactionRow>(
      `SELECT t.id,
              to_char(${canonicalTransactionDate}, 'YYYY-MM-DD') AS service_date,
              t.individual_id,
              CASE WHEN individual.id IS NULL THEN NULL
                   ELSE COALESCE(individual.display_name, individual.normalized_name) END AS individual_name,
              t.employee_id,
              CASE WHEN employee.id IS NULL THEN NULL
                   ELSE COALESCE(employee.display_name, employee.normalized_name) END AS employee_name,
              program.name AS program_name,
              effective_payment_recipient(t.payment_recipient, program.payment_recipient) AS payment_recipient,
              t.imported_amount::text AS gross_amount,
              COALESCE(
                t.calculated_internal_amount,
                t.spreadsheet_internal_amount,
                CASE WHEN t.internal_rate_applied IS NOT NULL AND t.imported_hours IS NOT NULL
                     THEN t.internal_rate_applied * t.imported_hours END
              )::text AS base_amount,
              person_term.employee_share_percent::text AS person_share_percent,
              employee_deal.id AS employee_deal_id,
              employee_deal.agency_cut_percent::text AS agency_cut_percent
         FROM payroll_transactions t
         LEFT JOIN individuals individual ON individual.id = t.individual_id
         LEFT JOIN employees employee ON employee.id = t.employee_id
         LEFT JOIN programs program ON program.id = t.program_id
         LEFT JOIN LATERAL (
           SELECT term.employee_share_percent
             FROM employee_individual_compensation_terms term
            WHERE term.employee_id = t.employee_id
              AND term.individual_id = t.individual_id
              AND term.status = 'active'
              AND term.effective_from <= ${canonicalTransactionDate}
              AND (term.effective_to IS NULL OR term.effective_to >= ${canonicalTransactionDate})
            ORDER BY term.effective_from DESC, term.created_at DESC
            LIMIT 1
         ) person_term ON true
         LEFT JOIN LATERAL (
           SELECT deal.id, deal.agency_cut_percent
             FROM employee_deals deal
            WHERE deal.employee_id = t.employee_id
              AND deal.status = 'active'
              AND deal.effective_from <= ${canonicalTransactionDate}
              AND (deal.effective_to IS NULL OR deal.effective_to >= ${canonicalTransactionDate})
            ORDER BY deal.effective_from DESC, deal.created_at DESC
            LIMIT 1
         ) employee_deal ON true
        WHERE ${canonicalTransactionDate} >= $1::date
          AND ${canonicalTransactionDate} < $2::date
        ORDER BY ${canonicalTransactionDate} DESC, t.id DESC`,
      [range.start, range.endExclusive],
    ),
    pool.query<CheckRow>(
      `SELECT check_fact.id,
              to_char(${canonicalCheckDate}, 'YYYY-MM-DD') AS service_date,
              check_fact.employee_id,
              COALESCE(employee.display_name, employee.normalized_name) AS employee_name,
              check_fact.check_number,
              check_fact.actual_gross::text,
              check_fact.actual_net::text,
              deal.direct_rule,
              deal.direct_percent::text
         FROM employee_payroll_checks check_fact
         JOIN employees employee ON employee.id = check_fact.employee_id
         LEFT JOIN LATERAL (
           SELECT employee_deal.direct_rule, employee_deal.direct_percent
             FROM employee_deals employee_deal
            WHERE employee_deal.employee_id = check_fact.employee_id
              AND employee_deal.status = 'active'
              AND employee_deal.effective_from <= ${canonicalCheckDate}
              AND (employee_deal.effective_to IS NULL OR employee_deal.effective_to >= ${canonicalCheckDate})
            ORDER BY employee_deal.effective_from DESC, employee_deal.created_at DESC
            LIMIT 1
         ) deal ON true
        WHERE check_fact.verification_status = 'verified'
          AND ${canonicalCheckDate} >= $1::date
          AND ${canonicalCheckDate} < $2::date
          AND EXISTS (
            SELECT 1
              FROM payroll_transactions source_transaction
              LEFT JOIN programs source_program ON source_program.id = source_transaction.program_id
             WHERE source_transaction.payroll_check_id = check_fact.id
               AND effective_payment_recipient(
                     source_transaction.payment_recipient,
                     source_program.payment_recipient
                   ) = 'employee'
          )
        ORDER BY ${canonicalCheckDate} DESC, employee_name, check_fact.id`,
      [range.start, range.endExclusive],
    ),
    pool.query<SetAsideRow>(
      `SELECT strategy.id AS strategy_id, strategy.individual_id,
              COALESCE(individual.display_name, individual.normalized_name) AS individual_name,
              strategy.label AS setup_name,
              strategy.cut1_percent::text,
              strategy.cut2_percent::text,
              strategy.after_all::text AS approved_final
         FROM calculation_strategies strategy
         JOIN individuals individual ON individual.id = strategy.individual_id
        WHERE strategy.status = 'active'
        ORDER BY individual_name, strategy.sort_order, strategy.label`,
    ),
    pool.query<ClassInvoiceRow>(
      `SELECT invoice.id, invoice.invoice_number, invoice.invoice_date::text,
              invoice.individual_id,
              COALESCE(individual.display_name, individual.normalized_name) AS individual_name,
              budget.program_id, program.name AS program_name,
              invoice.total_amount::text,
              effective_split.agency_share_percent::text,
              EXISTS (
                SELECT 1
                 FROM individual_program_revenue_terms any_split
                 WHERE any_split.individual_id = invoice.individual_id
                   AND any_split.program_id = budget.program_id
                   AND any_split.effective_from <= invoice.invoice_date
              ) AS custom_split_required
         FROM class_invoices invoice
         JOIN individuals individual ON individual.id = invoice.individual_id
         JOIN class_budget_periods budget ON budget.id = invoice.class_budget_period_id
         LEFT JOIN programs program ON program.id = budget.program_id
         LEFT JOIN LATERAL (
           SELECT split.agency_share_percent
             FROM individual_program_revenue_terms split
            WHERE split.individual_id = invoice.individual_id
              AND split.program_id = budget.program_id
              AND split.status = 'active'
              AND split.effective_from <= invoice.invoice_date
              AND (split.effective_to IS NULL OR split.effective_to >= invoice.invoice_date)
            ORDER BY split.effective_from DESC, split.created_at DESC
            LIMIT 1
         ) effective_split ON true
        WHERE invoice.status = 'issued'
          AND invoice.invoice_date >= $1::date
          AND invoice.invoice_date < $2::date
        ORDER BY invoice.invoice_date DESC, invoice.invoice_number`,
      [range.start, range.endExclusive],
    ),
    listManualIncomeEntries(pool, { from: range.start, to: range.endInclusive }),
  ]);

  const transactions: AgencyTransactionActual[] = transactionResult.rows.map((row): AgencyTransactionActual => {
    const routed = row.payment_recipient === "excellent_staffing"
      ? agencyRoutedEmployeeShare({
          baseAmount: row.base_amount,
          personSharePercent: row.person_share_percent,
          employeeAgencyCutPercent: row.agency_cut_percent,
        })
      : null;
    return {
      id: row.id,
      serviceDate: row.service_date,
      individualId: row.individual_id,
      individualName: row.individual_name,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      programName: row.program_name,
      paymentRecipient: row.payment_recipient,
      grossAmount: row.gross_amount === null ? null : toMoney(row.gross_amount),
      baseAmount: row.base_amount === null ? null : toMoney(row.base_amount),
      employeeSharePercent: routed?.percent ?? null,
      employeeExpense: routed?.amount ?? null,
      payRuleSource: routed?.source ?? null,
    };
  });

  const directChecks = checkResult.rows.map<DirectPayCheckActual>((row) => {
    const amounts = directPayCheckAmounts({
      grossAmount: row.actual_gross,
      netAmount: row.actual_net,
      directRule: row.direct_rule,
      directPercent: row.direct_percent,
    });
    return {
      id: row.id,
      serviceDate: row.service_date,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      checkNumber: row.check_number,
      grossAmount: row.actual_gross === null ? null : toMoney(row.actual_gross),
      netAmount: toMoney(row.actual_net),
      taxes: amounts.taxes,
      employeeKeeps: amounts.employeeKeeps,
      employeeOwesAgency: amounts.employeeOwesAgency,
      dealLabel: directDealLabel(row),
    };
  });

  const setAsides = setAsideResult.rows.map<MonthlySetAsideActual>((row) => ({
    strategyId: row.strategy_id,
    individualId: row.individual_id,
    individualName: row.individual_name,
    setupName: row.setup_name,
    firstCutPercent: row.cut1_percent,
    secondCutPercent: row.cut2_percent,
    approvedMonthlyFinal: approvedMonthlySetAside(row.approved_final),
  }));

  const classInvoices = classResult.rows.map<ClassInvoiceActual>((row) => {
    const split = classInvoiceSplit({
      grossAmount: row.total_amount,
      agencySharePercent: row.agency_share_percent,
      customSplitRequired: row.custom_split_required,
    });
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      individualId: row.individual_id,
      individualName: row.individual_name,
      programId: row.program_id,
      programName: row.program_name,
      grossAmount: toMoney(row.total_amount),
      agencySharePercent: split.agencySharePercent,
      agencyAmount: split.agencyAmount,
      individualExpense: split.individualExpense,
      splitSource: split.source,
    };
  });

  const transactionIncome = transactions.reduce((sum, row) => sum.plus(row.grossAmount ?? 0), dec(0));
  const classIncome = classInvoices.reduce((sum, row) => sum.plus(row.grossAmount), dec(0));
  const manualIncomeTotal = manualIncome.reduce((sum, row) => sum.plus(row.grossAmount), dec(0));
  const approvedSetAsides = setAsides.reduce(
    (sum, row) => sum.plus(row.approvedMonthlyFinal ?? 0),
    dec(0),
  );
  const taxes = directChecks.reduce((sum, row) => sum.plus(row.taxes ?? 0), dec(0));
  const directEmployeeKeeps = directChecks.reduce(
    (sum, row) => sum.plus(row.employeeKeeps ?? 0),
    dec(0),
  );
  const agencyRoutedEmployeeExpenseTotal = transactions.reduce(
    (sum, row) => sum.plus(row.employeeExpense ?? 0),
    dec(0),
  );
  const classIndividualShare = classInvoices.reduce(
    (sum, row) => sum.plus(row.individualExpense ?? 0),
    dec(0),
  );
  const manualIndividualShare = manualIncome.reduce(
    (sum, row) => sum.plus(row.individualAmount),
    dec(0),
  );
  const totalIncome = transactionIncome.plus(classIncome).plus(manualIncomeTotal);
  const totalExpenses = approvedSetAsides
    .plus(taxes)
    .plus(directEmployeeKeeps)
    .plus(agencyRoutedEmployeeExpenseTotal)
    .plus(classIndividualShare)
    .plus(manualIndividualShare);

  return {
    month: range.month,
    periodStart: range.start,
    periodEnd: range.endInclusive,
    transactions,
    directChecks,
    setAsides,
    classInvoices,
    manualIncome,
    totals: {
      income: {
        transactions: toMoney(transactionIncome),
        classes: toMoney(classIncome),
        manual: toMoney(manualIncomeTotal),
        total: toMoney(totalIncome),
      },
      expenses: {
        approvedSetAsides: toMoney(approvedSetAsides),
        taxes: toMoney(taxes),
        directEmployeeKeeps: toMoney(directEmployeeKeeps),
        agencyRoutedEmployeeShare: toMoney(agencyRoutedEmployeeExpenseTotal),
        classIndividualShare: toMoney(classIndividualShare),
        manualIndividualShare: toMoney(manualIndividualShare),
        total: toMoney(totalExpenses),
      },
      agencyResult: toMoney(totalIncome.minus(totalExpenses)),
    },
    coverage: {
      transactionsMissingAmount: transactions.filter((row) => row.grossAmount === null).length,
      agencyTransactionsMissingBase: transactions.filter((row) => (
        row.paymentRecipient === "excellent_staffing" && row.baseAmount === null
      )).length,
      agencyTransactionsMissingPayRule: transactions.filter((row) => (
        row.paymentRecipient === "excellent_staffing" && row.payRuleSource === "missing"
      )).length,
      directChecksMissingGross: directChecks.filter((row) => row.grossAmount === null).length,
      directChecksGrossBelowNet: directChecks.filter((row) => (
        row.grossAmount !== null && dec(row.grossAmount).lessThan(row.netAmount)
      )).length,
      directChecksMissingDeal: directChecks.filter((row) => row.dealLabel === null).length,
      classInvoicesMissingProgram: classInvoices.filter((row) => row.programId === null).length,
      classInvoicesMissingSplit: classInvoices.filter((row) => row.splitSource === "missing").length,
      setupsMissingApprovedFinal: setAsides.filter((row) => row.approvedMonthlyFinal === null).length,
      unknownPaymentRecipients: transactions.filter((row) => row.paymentRecipient === "unknown").length,
    },
  };
}

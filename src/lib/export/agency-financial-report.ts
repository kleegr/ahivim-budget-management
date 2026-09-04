import type {
  AgencyFinancialCoverage,
  AgencyFinancialReport,
  PayRuleSource,
} from "@/lib/data/agency-financial-report";
import type { ManualIncomeSource } from "@/lib/manage/agency-financials";
import type { ExportTable } from "./tabular";

const MANUAL_SOURCE_LABEL: Record<ManualIncomeSource, string> = {
  class: "Class payment received",
  reimbursement: "Reimbursement",
  custom_program: "Custom program",
  other: "Other income",
};

const COVERAGE_LABEL: Record<keyof AgencyFinancialCoverage, string> = {
  transactionsMissingAmount: "Transactions missing amount",
  agencyTransactionsMissingBase: "Agency transactions missing employee base",
  agencyTransactionsMissingPayRule: "Agency transactions missing pay rule",
  directChecksMissingGross: "Direct checks missing gross",
  directChecksMissingWithholding: "Direct checks missing verified withholding (excluded, not inferred)",
  directChecksGrossBelowNet: "Direct checks with gross below net",
  directChecksMissingDeal: "Direct checks missing employee deal",
  classInvoicesMissingProgram: "Class invoices missing program",
  classInvoicesMissingSplit: "Class invoices missing split",
  classInvoiceDuplicatesExcluded: "Duplicate class invoices excluded",
  setupsMissingApprovedFinal: "Setups missing approved final",
  setAsideHistoriesUnavailable: "Set-aside histories unavailable",
  manualIncomeDuplicatesExcluded: "Other-income duplicates excluded",
  unknownPaymentRecipients: "Transactions with unknown payment recipient",
};

function paymentRecipientLabel(value: string): string {
  if (value === "excellent_staffing") return "Agency";
  if (value === "employee") return "Employee";
  return "Unknown";
}

function payRuleLabel(value: PayRuleSource | null): string {
  if (value === null) return "Direct check";
  if (value === "person_rule") return "Person rule";
  if (value === "employee_default") return "Employee default";
  return "Missing";
}

function setAsideSourceLabel(report: AgencyFinancialReport["setAsides"][number]): string {
  if (!report.historyAvailable) return "History unavailable";
  if (report.stateSource === "saved_revision") return `History snapshot #${report.revisionNumber ?? "?"}`;
  return "Current setup";
}

/** Convert the exact on-screen actual snapshot into the shared export shape. */
export function agencyFinancialExportTables(report: AgencyFinancialReport): ExportTable[] {
  const countedClassReceipts = report.manualIncome.filter((row) => (
    row.sourceType === "class" && row.countedInIncome
  )).length;
  const matchedClassReceipts = report.manualIncome.filter((row) => (
    row.sourceType === "class" && !row.countedInIncome && row.matchedIncomeSource !== null
  )).length;
  const countedOtherIncome = report.manualIncome.filter((row) => (
    row.sourceType !== "class" && row.countedInIncome
  )).length;
  return [
    {
      title: "Report period",
      columns: [
        { key: "month", header: "Month", type: "text" },
        { key: "periodStart", header: "Period start", type: "date" },
        { key: "periodEnd", header: "Period end", type: "date" },
      ],
      rows: [{ month: report.month, periodStart: report.periodStart, periodEnd: report.periodEnd }],
    },
    {
      title: "Summary totals",
      columns: [
        { key: "section", header: "Section", type: "text" },
        { key: "metric", header: "Metric", type: "text" },
        { key: "records", header: "Records", type: "int" },
        { key: "amount", header: "Amount", type: "money" },
      ],
      rows: [
        { section: "Income", metric: "Google Sheet transactions", records: report.transactions.length, amount: report.totals.income.transactions },
        { section: "Income", metric: "Actual class receipts", records: countedClassReceipts, amount: report.totals.income.classes },
        { section: "Income deduplication", metric: "Class receipts whose gross is already in Sheet income", records: matchedClassReceipts, amount: null },
        { section: "Income exclusions", metric: "Issued class invoices - receivables only", records: report.classInvoices.length, amount: null },
        { section: "Income", metric: "Reimbursements, custom programs, and other income", records: countedOtherIncome, amount: report.totals.income.manual },
        { section: "Income", metric: "Total income", records: report.transactions.length + countedClassReceipts + countedOtherIncome, amount: report.totals.income.total },
        { section: "Transaction composition", metric: "Funder billed - complete base rows", records: report.transactionBreakdown.completeRows, amount: report.transactionBreakdown.funderBilled },
        { section: "Transaction composition", metric: "Employee base - complete base rows", records: report.transactionBreakdown.completeRows, amount: report.transactionBreakdown.employeeBase },
        { section: "Transaction composition", metric: "Agency spread - complete base rows", records: report.transactionBreakdown.completeRows, amount: report.transactionBreakdown.agencySpread },
        { section: "Transaction composition", metric: "Rows excluded from base/spread split", records: report.transactionBreakdown.excludedRows, amount: null },
        { section: "Agency-routed deal", metric: "Funder billed - complete deal rows", records: report.transactionBreakdown.agencyRouted.completeRows, amount: report.transactionBreakdown.agencyRouted.funderBilled },
        { section: "Agency-routed deal", metric: "Employee base - complete deal rows", records: report.transactionBreakdown.agencyRouted.completeRows, amount: report.transactionBreakdown.agencyRouted.employeeBase },
        { section: "Agency-routed deal", metric: "Agency spread - outside deal", records: report.transactionBreakdown.agencyRouted.completeRows, amount: report.transactionBreakdown.agencyRouted.agencySpread },
        { section: "Agency-routed deal", metric: "Employee share of base", records: report.transactionBreakdown.agencyRouted.completeRows, amount: report.transactionBreakdown.agencyRouted.employeeShareOfBase },
        { section: "Agency-routed deal", metric: "Agency share of base", records: report.transactionBreakdown.agencyRouted.completeRows, amount: report.transactionBreakdown.agencyRouted.agencyShareOfBase },
        { section: "Agency-routed deal", metric: "Rows excluded from complete deal split", records: report.transactionBreakdown.agencyRouted.excludedRows, amount: null },
        { section: "Expenses", metric: "Approved monthly set-asides", records: null, amount: report.totals.expenses.approvedSetAsides },
        { section: "Expenses", metric: "Verified payroll withholding", records: null, amount: report.totals.expenses.taxes },
        { section: "Expenses", metric: "Direct-pay employee keeps", records: null, amount: report.totals.expenses.directEmployeeKeeps },
        { section: "Expenses", metric: "Agency-routed employee share", records: null, amount: report.totals.expenses.agencyRoutedEmployeeShare },
        { section: "Expenses", metric: "Class receipt individual share", records: null, amount: report.totals.expenses.classIndividualShare },
        { section: "Expenses", metric: "Other recorded income individual share", records: null, amount: report.totals.expenses.manualIndividualShare },
        { section: "Expenses", metric: "Total expenses", records: null, amount: report.totals.expenses.total },
        { section: "Result", metric: "Agency result", records: null, amount: report.totals.agencyResult },
      ],
    },
    {
      title: "Transaction actuals",
      columns: [
        { key: "serviceDate", header: "Date", type: "date" },
        { key: "sourceRef", header: "Source reference", type: "text" },
        { key: "individual", header: "Individual", type: "text" },
        { key: "employee", header: "Employee", type: "text" },
        { key: "program", header: "Program", type: "text" },
        { key: "paidTo", header: "Paid to", type: "text" },
        { key: "gross", header: "Funder billed", type: "money" },
        { key: "employeeBase", header: "Employee base", type: "money" },
        { key: "agencySpread", header: "Agency spread", type: "money" },
        { key: "payRule", header: "Pay rule", type: "text" },
        { key: "employeeSharePercent", header: "Employee share", type: "percent" },
        { key: "employeeExpense", header: "Employee share of base", type: "money" },
        { key: "agencyShareOfBase", header: "Agency share of base", type: "money" },
      ],
      rows: report.transactions.map((row) => ({
        serviceDate: row.serviceDate,
        sourceRef: row.sourceRef,
        individual: row.individualName ?? "Unmatched",
        employee: row.employeeName ?? "Unmatched",
        program: row.programName ?? "Unmatched",
        paidTo: paymentRecipientLabel(row.paymentRecipient),
        gross: row.grossAmount,
        employeeBase: row.baseAmount,
        agencySpread: row.agencySpread,
        payRule: payRuleLabel(row.payRuleSource),
        employeeSharePercent: row.employeeSharePercent,
        employeeExpense: row.employeeExpense,
        agencyShareOfBase: row.agencyShareOfBase,
      })),
      emptyMessage: "No transaction actuals in this month.",
    },
    {
      title: "Verified direct-pay checks",
      columns: [
        { key: "serviceDate", header: "Date", type: "date" },
        { key: "employee", header: "Employee", type: "text" },
        { key: "checkNumber", header: "Check", type: "text" },
        { key: "gross", header: "Gross", type: "money" },
        { key: "net", header: "Net", type: "money" },
        { key: "taxes", header: "Verified withholding", type: "money" },
        { key: "deal", header: "Deal", type: "text" },
        { key: "employeeKeeps", header: "Employee keeps", type: "money" },
        { key: "agencyReceives", header: "Agency receives", type: "money" },
      ],
      rows: report.directChecks.map((row) => ({
        serviceDate: row.serviceDate,
        employee: row.employeeName,
        checkNumber: row.checkNumber ?? "No number",
        gross: row.grossAmount,
        net: row.netAmount,
        taxes: row.taxes,
        deal: row.dealLabel ?? "Missing",
        employeeKeeps: row.employeeKeeps,
        agencyReceives: row.employeeOwesAgency,
      })),
      emptyMessage: "No verified direct-pay checks in this month.",
    },
    {
      title: "Approved monthly set-asides",
      columns: [
        { key: "individual", header: "Individual", type: "text" },
        { key: "setup", header: "Setup", type: "text" },
        { key: "cut1", header: "Cut 1", type: "percent" },
        { key: "cut2", header: "Cut 2", type: "percent" },
        { key: "ruleSource", header: "Rule source", type: "text" },
        { key: "effective", header: "Effective", type: "text" },
        { key: "approvedFinal", header: "Approved final / month", type: "money" },
      ],
      rows: report.setAsides.map((row) => ({
        individual: row.individualName,
        setup: row.setupName,
        cut1: row.historyAvailable ? row.firstCutPercent : null,
        cut2: row.historyAvailable ? row.secondCutPercent : null,
        ruleSource: setAsideSourceLabel(row),
        effective: row.effectiveAt,
        approvedFinal: row.historyAvailable ? row.approvedMonthlyFinal : null,
      })),
      emptyMessage: "No active or unresolved financial setups.",
    },
    {
      title: "Class invoice receivables",
      columns: [
        { key: "invoice", header: "Invoice", type: "text" },
        { key: "invoiceDate", header: "Date", type: "date" },
        { key: "individual", header: "Individual", type: "text" },
        { key: "program", header: "Program", type: "text" },
        { key: "invoiceAmount", header: "Invoice amount", type: "money" },
        { key: "agencySplit", header: "Agency split", type: "percent" },
        { key: "agencyAllocation", header: "Agency allocation", type: "money" },
        { key: "individualAllocation", header: "Individual allocation", type: "money" },
        { key: "status", header: "Status", type: "text" },
      ],
      rows: report.classInvoices.map((row) => ({
        invoice: row.invoiceNumber,
        invoiceDate: row.invoiceDate,
        individual: row.individualName,
        program: row.programName ?? "Not linked",
        invoiceAmount: row.grossAmount,
        agencySplit: row.agencySharePercent,
        agencyAllocation: row.agencyAmount,
        individualAllocation: row.individualExpense,
        status: "Reference only - not actual cash income",
      })),
      emptyMessage: "No issued class invoices in this month.",
    },
    {
      title: "Recorded receipts and other income",
      columns: [
        { key: "serviceDate", header: "Date", type: "date" },
        { key: "sourceType", header: "Type", type: "text" },
        { key: "individual", header: "Individual", type: "text" },
        { key: "program", header: "Program", type: "text" },
        { key: "reference", header: "Reference", type: "text" },
        { key: "gross", header: "Gross", type: "money" },
        { key: "agency", header: "Agency", type: "money" },
        { key: "individualExpense", header: "Individual expense", type: "money" },
        { key: "countedInIncome", header: "Counted in income", type: "text" },
        { key: "countedSplitExpense", header: "Individual split counted", type: "text" },
        { key: "duplicateSource", header: "Matched source", type: "text" },
        { key: "decisionReason", header: "Decision reason", type: "text" },
      ],
      rows: report.manualIncome.map((row) => ({
        serviceDate: row.serviceDate,
        sourceType: MANUAL_SOURCE_LABEL[row.sourceType],
        individual: row.individualName ?? "General",
        program: row.programName ?? "General",
        reference: row.sourceRef,
        gross: row.grossAmount,
        agency: row.agencyAmount,
        individualExpense: row.individualAmount,
        countedInIncome: row.countedInIncome ? "Yes" : "No",
        countedSplitExpense: row.countedSplitExpense ? "Yes" : "No",
        duplicateSource: row.matchedIncomeSource?.sourceRef ?? null,
        decisionReason: row.countSeparatelyReason,
      })),
      emptyMessage: "No receipts or other income recorded in this month.",
    },
    {
      title: "Coverage checks",
      columns: [
        { key: "check", header: "Check", type: "text" },
        { key: "count", header: "Items", type: "int" },
      ],
      rows: (Object.keys(COVERAGE_LABEL) as (keyof AgencyFinancialCoverage)[]).map((key) => ({
        check: COVERAGE_LABEL[key],
        count: report.coverage[key],
      })),
    },
  ];
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  HandCoins,
  Plus,
  ReceiptText,
  Settings2,
  Split,
  Trash2,
  Users,
} from "lucide-react";
import { ModalShell } from "@/components/schedule/shared";
import {
  CountSeparatelyForm,
  EmployeeTermForm,
  IncomeForm,
  ProgramSplitForm,
  VoidIncomeForm,
  type CountSeparatelyTarget,
} from "@/components/reports/agency-financial-workspace-forms";
import {
  AutomaticSourceLink,
  SetAsideRuleSource,
  SimpleTable,
  SOURCE_LABEL,
  SummaryMetric,
  TransactionMoneyBridge,
  VIEWS,
  monthLabel,
  percent,
  request,
  ruleEffectiveLabel,
  shiftMonth,
  type View,
} from "@/components/reports/agency-financial-shared";
import { Money, Notice, Td, Tr } from "@/components/ui";
import type {
  AgencyFinancialOptions,
  AgencyFinancialReport,
} from "@/lib/data/agency-financial-report";
import type {
  EmployeeIndividualCompensationTerm,
  ManualIncomeEntry,
  ProgramRevenueTerm,
} from "@/lib/manage/agency-financials";
import { agencyDate } from "@/lib/business/agency-time";
import { collectionsPayrollCheckFocusHref } from "@/lib/nav/collections-links";
import { dec } from "@/lib/money";

type Modal = "income" | "program-split" | "employee-term" | null;



export default function AgencyFinancialWorkspace({
  report,
  options,
  programTerms,
  employeeTerms,
  incomeHistory,
}: {
  report: AgencyFinancialReport;
  options: AgencyFinancialOptions;
  programTerms: ProgramRevenueTerm[];
  employeeTerms: EmployeeIndividualCompensationTerm[];
  incomeHistory: ManualIncomeEntry[];
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("summary");
  const [modal, setModal] = useState<Modal>(null);
  const [voidEntry, setVoidEntry] = useState<ManualIncomeEntry | null>(null);
  const [countSeparatelyTarget, setCountSeparatelyTarget] = useState<CountSeparatelyTarget | null>(null);
  const [splitRepair, setSplitRepair] = useState<{ individualId: string; programId: string; effectiveFrom?: string } | null>(null);
  const [payRuleRepair, setPayRuleRepair] = useState<{ employeeId: string; individualId: string; effectiveFrom?: string } | null>(null);
  const [classProgramRepairTarget, setClassProgramRepairTarget] = useState<AgencyFinancialReport["classInvoices"][number] | null>(null);
  const [repairingClassProgramId, setRepairingClassProgramId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const issueCount = Object.values(report.coverage).reduce((sum, value) => sum + value, 0);
  const manualIncomeById = new Map(report.manualIncome.map((row) => [row.id, row]));
  const countedClassReceiptCount = report.manualIncome.filter((row) => (
    row.sourceType === "class" && row.countedInIncome
  )).length;
  const matchedClassReceiptCount = report.manualIncome.filter((row) => (
    row.sourceType === "class" && !row.countedInIncome && row.matchedIncomeSource !== null
  )).length;
  const countedOtherIncomeCount = report.manualIncome.filter((row) => (
    row.sourceType !== "class" && row.countedInIncome
  )).length;
  const resultNegative = dec(report.totals.agencyResult).isNegative();
  const firstMissingTransactionAmount = report.transactions.find((row) => row.grossAmount === null);
  const firstMissingEmployeeBase = report.transactions.find((row) => row.paymentRecipient === "excellent_staffing" && row.baseAmount === null);
  const firstMissingPayRule = report.transactions.find((row) => row.payRuleSource === "missing");
  const firstUnknownRecipient = report.transactions.find((row) => !["excellent_staffing", "employee"].includes(row.paymentRecipient));
  const firstMissingCheckGross = report.directChecks.find((row) => row.grossAmount === null);
  const firstMissingCheckWithholding = report.directChecks.find((row) => row.taxes === null);
  const firstCheckGrossBelowNet = report.directChecks.find((row) => row.grossAmount !== null && dec(row.grossAmount).lt(row.netAmount));
  const firstMissingDirectDeal = report.directChecks.find((row) => row.dealLabel === null);
  const firstMissingClassSplit = report.classInvoices.find((row) => row.splitSource === "missing");
  const firstMissingClassProgram = report.classInvoices.find((row) => row.programId === null);
  const firstMissingApprovedFinal = report.setAsides.find((row) => row.historyAvailable && row.approvedMonthlyFinal === null);
  const historicalMonth = report.periodEnd < agencyDate();
  const saved = () => {
    setModal(null);
    setVoidEntry(null);
    setCountSeparatelyTarget(null);
    router.refresh();
  };
  const openProgramSplit = (selection: { individualId: string; programId: string; effectiveFrom?: string } | null = null) => {
    setSplitRepair(selection);
    setModal("program-split");
  };
  const openPayRule = (selection: { employeeId: string; individualId: string; effectiveFrom?: string } | null = null) => {
    setPayRuleRepair(selection);
    setModal("employee-term");
  };
  const openClassProgramRepair = (invoice: AgencyFinancialReport["classInvoices"][number]) => {
    setActionError(null);
    setClassProgramRepairTarget(invoice);
  };
  const repairClassProgram = async (invoice: AgencyFinancialReport["classInvoices"][number]) => {
    setRepairingClassProgramId(invoice.id);
    setActionError(null);
    const result = await request(
      `/api/agency-financials/class-invoices/${invoice.id}/link-program`,
      {
        classBudgetPeriodId: invoice.classBudgetPeriodId,
        reason: "Repair missing Classes program link from the agency financial report.",
      },
    );
    setRepairingClassProgramId(null);
    if (!result.ok) {
      setActionError(result.error ?? "The Classes program link could not be repaired.");
      return;
    }
    setClassProgramRepairTarget(null);
    router.refresh();
  };

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 border-b border-[var(--color-rule)] pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <Link className="btn btn-icon btn-secondary" aria-label="Previous month" title="Previous month" href={`/reports/agency-financials?month=${shiftMonth(report.month, -1)}`}><ChevronLeft className="h-4 w-4" aria-hidden /></Link>
          <div className="min-w-44 text-center">
            <p className="display text-lg font-semibold text-[var(--color-ink)]">{monthLabel(report.month)}</p>
            <p className="text-xs text-[var(--color-ink-faint)]">{report.periodStart} to {report.periodEnd}</p>
          </div>
          {report.month < agencyDate().slice(0, 7) ? <Link className="btn btn-icon btn-secondary" aria-label="Next month" title="Next month" href={`/reports/agency-financials?month=${shiftMonth(report.month, 1)}`}><ChevronRight className="h-4 w-4" aria-hidden /></Link> : <span className="btn btn-icon btn-secondary cursor-not-allowed opacity-50" aria-label="Next month unavailable" aria-disabled="true"><ChevronRight className="h-4 w-4" aria-hidden /></span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="btn btn-secondary" download href={`/api/agency-financials/export?format=csv&month=${report.month}`}><Download className="h-4 w-4" aria-hidden /> CSV</a>
          <a className="btn btn-secondary" download href={`/api/agency-financials/export?format=xlsx&month=${report.month}`}><FileSpreadsheet className="h-4 w-4" aria-hidden /> Excel</a>
          <button type="button" className="btn btn-secondary" onClick={() => openProgramSplit()}><Split className="h-4 w-4" aria-hidden /> Program split</button>
          <button type="button" className="btn btn-secondary" onClick={() => openPayRule()}><Users className="h-4 w-4" aria-hidden /> Employee pay rule</button>
          <button type="button" className="btn btn-primary" onClick={() => setModal("income")}><Plus className="h-4 w-4" aria-hidden /> Add income</button>
        </div>
      </div>

      <p className="-mt-2 mb-5 text-xs leading-5 text-[var(--color-ink-faint)]">
        <strong className="text-[var(--color-ink-soft)]">Date basis:</strong> service month, using period begin, otherwise check date, otherwise period end. Scheduled work and invoice dates do not become transaction income.
      </p>

      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--color-rule)]" role="tablist" aria-label="Agency financial report sections">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            onClick={() => setView(item.id)}
            className={`touch-target shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${view === item.id ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}
          >{item.label}</button>
        ))}
      </div>

      {actionError ? <div className="mb-5"><Notice tone="error" title="The repair could not be completed" action={<Link className="btn btn-sm btn-secondary" href="/settings#programs">Open program setup</Link>}>{actionError} After correcting the setup, use Repair program link again.</Notice></div> : null}

      {view === "summary" ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryMetric label="Actual income" value={report.totals.income.total} detail="Google Sheet transactions, class receipts, and other recorded payments" />
            <SummaryMetric label="Expenses" value={report.totals.expenses.total} detail="Set-asides, verified withholding, employee shares, and individual shares" />
            <SummaryMetric label="Agency result" value={report.totals.agencyResult} detail="Actual income minus the listed expenses" tone={resultNegative ? "negative" : "positive"} />
          </div>

          {issueCount > 0 ? (
            <Notice tone="warning" title={`${issueCount} item${issueCount === 1 ? "" : "s"} need attention`}>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {report.coverage.transactionsMissingAmount && firstMissingTransactionAmount ? <Link className="touch-target inline-flex items-center px-1 underline" href={`/transactions?transactionId=${firstMissingTransactionAmount.id}`}>{report.coverage.transactionsMissingAmount} missing transaction amount</Link> : null}
                {report.coverage.agencyTransactionsMissingBase && firstMissingEmployeeBase ? <Link className="touch-target inline-flex items-center px-1 underline" href={`/transactions?transactionId=${firstMissingEmployeeBase.id}`}>{report.coverage.agencyTransactionsMissingBase} missing employee base</Link> : null}
                {report.coverage.agencyTransactionsMissingPayRule && firstMissingPayRule ? firstMissingPayRule.employeeId && firstMissingPayRule.individualId ? <button className="touch-target inline-flex items-center px-1 underline" type="button" onClick={() => openPayRule({ employeeId: firstMissingPayRule.employeeId!, individualId: firstMissingPayRule.individualId!, effectiveFrom: firstMissingPayRule.serviceDate })}>{report.coverage.agencyTransactionsMissingPayRule} missing agency-routed pay rule</button> : <Link className="touch-target inline-flex items-center px-1 underline" href={`/transactions?transactionId=${firstMissingPayRule.id}`}>{report.coverage.agencyTransactionsMissingPayRule} missing agency-routed pay rule</Link> : null}
                {report.coverage.directChecksMissingGross && firstMissingCheckGross ? <Link className="touch-target inline-flex items-center px-1 underline" href={collectionsPayrollCheckFocusHref({ payrollCheckId: firstMissingCheckGross.id, month: report.month })}>{report.coverage.directChecksMissingGross} missing check gross</Link> : null}
                {report.coverage.directChecksMissingWithholding && firstMissingCheckWithholding ? <Link className="touch-target inline-flex items-center px-1 underline" href={collectionsPayrollCheckFocusHref({ payrollCheckId: firstMissingCheckWithholding.id, month: report.month })}>{report.coverage.directChecksMissingWithholding} missing verified withholding</Link> : null}
                {report.coverage.directChecksGrossBelowNet && firstCheckGrossBelowNet ? <Link className="touch-target inline-flex items-center px-1 underline" href={collectionsPayrollCheckFocusHref({ payrollCheckId: firstCheckGrossBelowNet.id, month: report.month })}>{report.coverage.directChecksGrossBelowNet} check gross below net</Link> : null}
                {report.coverage.directChecksMissingDeal && firstMissingDirectDeal ? <Link className="touch-target inline-flex items-center px-1 underline" href={`/employees/${firstMissingDirectDeal.employeeId}?view=deal&effectiveFrom=${firstMissingDirectDeal.serviceDate}`}>{report.coverage.directChecksMissingDeal} missing direct-pay deal</Link> : null}
                {report.coverage.classInvoicesMissingSplit && firstMissingClassSplit ? firstMissingClassSplit.programId ? <button className="touch-target inline-flex items-center px-1 underline" type="button" onClick={() => openProgramSplit({ individualId: firstMissingClassSplit.individualId, programId: firstMissingClassSplit.programId!, effectiveFrom: firstMissingClassSplit.invoiceDate })}>{report.coverage.classInvoicesMissingSplit} missing class split</button> : <Link className="touch-target inline-flex items-center px-1 underline" href={`/classes?month=${report.month}`}>{report.coverage.classInvoicesMissingSplit} missing class split</Link> : null}
                {report.coverage.classInvoicesMissingProgram && firstMissingClassProgram ? <button className="touch-target inline-flex items-center px-1 underline disabled:opacity-50" type="button" disabled={repairingClassProgramId !== null} onClick={() => openClassProgramRepair(firstMissingClassProgram)}>{report.coverage.classInvoicesMissingProgram} class invoice without a program</button> : null}
                {report.coverage.setupsMissingApprovedFinal && firstMissingApprovedFinal ? historicalMonth ? <button className="touch-target inline-flex items-center px-1 underline" type="button" onClick={() => setView("set-asides")}>{report.coverage.setupsMissingApprovedFinal} historical setup without approved final</button> : <Link className="touch-target inline-flex items-center px-1 underline" href={`/individuals/${firstMissingApprovedFinal.individualId}?view=financial`}>{report.coverage.setupsMissingApprovedFinal} setup without approved final</Link> : null}
                {report.coverage.setAsideHistoriesUnavailable ? <button className="touch-target inline-flex items-center px-1 underline" type="button" onClick={() => setView("set-asides")}>{report.coverage.setAsideHistoriesUnavailable} set-aside histor{report.coverage.setAsideHistoriesUnavailable === 1 ? "y" : "ies"} unavailable</button> : null}
                {report.coverage.manualIncomeDuplicatesExcluded ? <button className="touch-target inline-flex items-center px-1 underline" type="button" onClick={() => setView("other-income")}>{report.coverage.manualIncomeDuplicatesExcluded} matched other-income entr{report.coverage.manualIncomeDuplicatesExcluded === 1 ? "y" : "ies"} not counted as income</button> : null}
                {report.coverage.unknownPaymentRecipients && firstUnknownRecipient ? <Link className="touch-target inline-flex items-center px-1 underline" href={`/transactions?transactionId=${firstUnknownRecipient.id}`}>{report.coverage.unknownPaymentRecipients} unknown payment recipient</Link> : null}
              </div>
            </Notice>
          ) : (
            <Notice tone="success" title="All included records are fully configured">Every amount needed for this month has its source facts and pay rules.</Notice>
          )}

          <TransactionMoneyBridge report={report} onOpenTransactions={() => setView("transactions")} />

          <div className="grid gap-5 xl:grid-cols-2">
            <section className="card overflow-hidden">
              <header className="border-b border-[var(--color-rule)] px-5 py-3.5"><h2 className="display text-base font-semibold">Income</h2></header>
              <SimpleTable caption="Income summary" headers={[{ label: "Source" }, { label: "Records", numeric: true }, { label: "Gross income", numeric: true }]}>
                <Tr><Td><button type="button" className="font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("transactions")}>Google Sheet transactions</button></Td><Td numeric>{report.transactions.length}</Td><Td numeric><Money value={report.totals.income.transactions} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Actual class receipts{matchedClassReceiptCount ? <span className="block text-xs font-normal text-[var(--color-ink-soft)]">{matchedClassReceiptCount} same-payment gross {matchedClassReceiptCount === 1 ? "is" : "are"} already in Sheet income</span> : null}</button></Td><Td numeric>{countedClassReceiptCount}</Td><Td numeric><Money value={report.totals.income.classes} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Reimbursements, custom programs, and other income{report.coverage.manualIncomeDuplicatesExcluded ? <span className="block text-xs font-normal text-[var(--color-danger)]">{report.coverage.manualIncomeDuplicatesExcluded} not counted</span> : null}</button></Td><Td numeric>{countedOtherIncomeCount}</Td><Td numeric><Money value={report.totals.income.manual} /></Td></Tr>
                <tr className="border-t border-[var(--color-rule-strong)] font-semibold"><Td>Total income</Td><Td numeric>{report.transactions.length + countedClassReceiptCount + countedOtherIncomeCount}</Td><Td numeric><Money value={report.totals.income.total} /></Td></tr>
              </SimpleTable>
            </section>

            <section className="card overflow-hidden">
              <header className="border-b border-[var(--color-rule)] px-5 py-3.5"><h2 className="display text-base font-semibold">Expenses</h2></header>
              <SimpleTable caption="Expense summary" headers={[{ label: "Expense" }, { label: "Amount", numeric: true }]}>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("set-asides")}>Approved monthly set-asides</button></Td><Td numeric><Money value={report.totals.expenses.approvedSetAsides} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("checks")}>Verified payroll withholding</button></Td><Td numeric><Money value={report.totals.expenses.taxes} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("checks")}>Direct-pay employee keeps</button></Td><Td numeric><Money value={report.totals.expenses.directEmployeeKeeps} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("transactions")}>Agency-routed employee share</button></Td><Td numeric><Money value={report.totals.expenses.agencyRoutedEmployeeShare} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Class receipt individual share</button></Td><Td numeric><Money value={report.totals.expenses.classIndividualShare} /></Td></Tr>
                <Tr><Td><button type="button" className="text-left font-medium text-[var(--color-primary)] hover:underline" onClick={() => setView("other-income")}>Other recorded income individual share</button></Td><Td numeric><Money value={report.totals.expenses.manualIndividualShare} /></Td></Tr>
                <tr className="border-t border-[var(--color-rule-strong)] font-semibold"><Td>Total expenses</Td><Td numeric><Money value={report.totals.expenses.total} /></Td></tr>
              </SimpleTable>
            </section>
          </div>
        </div>
      ) : null}

      {view === "transactions" ? (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5">
            <div><h2 className="display text-base font-semibold">Transaction actuals</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Funder billed = Employee base + Agency spread. On agency-routed rows, the pay rule divides Employee base into employee and agency shares; Agency spread stays outside the deal.</p></div>
            <Link className="btn btn-sm btn-secondary" href={`/transactions?serviceFrom=${report.periodStart}&serviceTo=${report.periodEnd}`}><ReceiptText className="h-4 w-4" aria-hidden /> Open transactions</Link>
          </header>
          {report.transactions.length ? <SimpleTable caption="Transaction actuals" headers={[{ label: "Date" }, { label: "Individual" }, { label: "Employee" }, { label: "Program" }, { label: "Paid to" }, { label: "Funder billed", numeric: true }, { label: "Employee base", numeric: true }, { label: "Agency spread", numeric: true }, { label: "Pay rule" }, { label: "Employee share of base", numeric: true }, { label: "Agency share of base", numeric: true }, { label: "" }]}>
            {report.transactions.map((row) => <Tr key={row.id}>
              <Td>{row.serviceDate}</Td><Td>{row.individualName ?? "Unmatched"}</Td><Td>{row.employeeName ?? "Unmatched"}</Td><Td>{row.programName ?? "Unmatched"}</Td><Td>{row.paymentRecipient === "excellent_staffing" ? "Agency" : row.paymentRecipient === "employee" ? "Employee" : "Unknown"}</Td>
              <Td numeric><Money value={row.grossAmount} /></Td><Td numeric><Money value={row.baseAmount} /></Td><Td numeric><Money value={row.agencySpread} /></Td>
              <Td>{row.payRuleSource === null
                ? "Direct check"
                : row.payRuleSource === "person_rule"
                  ? `Person rule ${percent(row.employeeSharePercent)}`
                  : row.payRuleSource === "employee_default"
                    ? `Employee default ${percent(row.employeeSharePercent)}`
                    : row.employeeId && row.individualId
                      ? <button type="button" className="font-semibold text-[var(--color-danger)] underline" onClick={() => openPayRule({ employeeId: row.employeeId!, individualId: row.individualId!, effectiveFrom: row.serviceDate })}>Set pay rule</button>
                      : <Link className="font-semibold text-[var(--color-danger)] underline" href={`/transactions?transactionId=${row.id}`}>Fix transaction</Link>}</Td>
              <Td numeric>{row.paymentRecipient === "employee" ? <span className="text-[var(--color-ink-faint)]">Check-level</span> : <Money value={row.employeeExpense} />}</Td>
              <Td numeric>{row.paymentRecipient === "employee" ? <span className="text-[var(--color-ink-faint)]">Check-level</span> : <Money value={row.agencyShareOfBase} />}</Td>
              <Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={`/transactions?transactionId=${row.id}`}>View</Link></Td>
            </Tr>)}
          </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No transaction actuals in this month.</p>}
        </section>
      ) : null}

      {view === "checks" ? (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Verified direct-pay checks</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Each check is counted once. Withholding comes from its separately verified check field; missing values are disclosed and excluded, never inferred from gross minus net. Employee share is calculated from net.</p></div><Link className="btn btn-sm btn-secondary" href="/masser?view=checks"><HandCoins className="h-4 w-4" aria-hidden /> Open checks</Link></header>
          {report.directChecks.length ? <SimpleTable caption="Verified direct-pay checks" headers={[{ label: "Date" }, { label: "Employee" }, { label: "Check" }, { label: "Gross", numeric: true }, { label: "Net", numeric: true }, { label: "Withholding", numeric: true }, { label: "Deal" }, { label: "Employee keeps", numeric: true }, { label: "Agency receives", numeric: true }, { label: "" }]}>
            {report.directChecks.map((row) => <Tr key={row.id}><Td>{row.serviceDate}</Td><Td>{row.employeeName}</Td><Td>{row.checkNumber ?? "No number"}</Td><Td numeric><Money value={row.grossAmount} /></Td><Td numeric><Money value={row.netAmount} /></Td><Td numeric><Money value={row.taxes} /></Td><Td>{row.dealLabel ?? <Link className="font-semibold text-[var(--color-danger)] underline" href={`/employees/${row.employeeId}?view=deal&effectiveFrom=${row.serviceDate}`}>Set employee deal</Link>}</Td><Td numeric><Money value={row.employeeKeeps} /></Td><Td numeric><Money value={row.employeeOwesAgency} /></Td><Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={collectionsPayrollCheckFocusHref({ payrollCheckId: row.id, month: report.month })}>View</Link></Td></Tr>)}
          </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No verified direct-pay checks in this month.</p>}
        </section>
      ) : null}

      {view === "set-asides" ? (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Approved monthly set-asides</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">August 2026 is the first month with trustworthy setup history. Earlier months cannot be reconstructed and are not counted. From August onward, saved setup snapshots are used when available. Only Approved final is an expense; Cut 1 and Cut 2 are shown for reference.</p></div><Link className="btn btn-sm btn-secondary" href="/calculations"><Settings2 className="h-4 w-4" aria-hidden /> Financial setup</Link></header>
          {report.coverage.setAsideHistoriesUnavailable ? (
            <div className="border-b border-[var(--color-rule)] px-5 py-4">
              <Notice tone="warning" title={`${report.coverage.setAsideHistoriesUnavailable} setup histor${report.coverage.setAsideHistoriesUnavailable === 1 ? "y" : "ies"} cannot be reconstructed`}>
                These setups have no trustworthy saved state for this month. They remain visible below and are excluded from the total. <Link className="touch-target inline-flex items-center px-1 font-semibold underline" href="/calculations">Review current financial setups</Link>.
              </Notice>
            </div>
          ) : null}
          {report.setAsides.length ? <SimpleTable caption="Monthly set-asides" headers={[{ label: "Individual" }, { label: "Setup" }, { label: "Cut 1" }, { label: "Cut 2" }, { label: "Rule source" }, { label: "Effective" }, { label: "Approved final / month", numeric: true }, { label: "" }]}>
            {report.setAsides.map((row) => <Tr key={row.strategyId}><Td>{row.individualName}</Td><Td>{row.setupName}</Td><Td>{row.historyAvailable ? percent(row.firstCutPercent) : "Not available"}</Td><Td>{row.historyAvailable ? percent(row.secondCutPercent) : "Not available"}</Td><Td><SetAsideRuleSource row={row} /></Td><Td>{ruleEffectiveLabel(row.effectiveAt)}</Td><Td numeric>{!row.historyAvailable ? <span className="font-medium text-[var(--color-ink-faint)]">Not counted</span> : row.approvedMonthlyFinal === null ? historicalMonth ? <span className="font-medium text-[var(--color-danger)]" title="Closed-month setup history is not changed by current edits.">Not counted - history locked</span> : <Link className="font-semibold text-[var(--color-danger)] underline" href={`/individuals/${row.individualId}?view=financial`}>Set approved final</Link> : <Money value={row.approvedMonthlyFinal} />}</Td><Td><Link className="text-xs font-semibold text-[var(--color-primary)] hover:underline" href={`/individuals/${row.individualId}?view=financial`}>View current</Link></Td></Tr>)}
          </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No active or unresolved financial setups.</p>}
        </section>
      ) : null}

      {view === "other-income" ? (
        <div className="space-y-5">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Class invoice receivables</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Invoices show what was billed and use the class allowance. They are references, not cash income. Actual class payments appear only after a Google Sheet transaction arrives or you record the payment below.</p></div><Link className="btn btn-sm btn-secondary" href={`/classes?month=${report.month}`}><CalendarDays className="h-4 w-4" aria-hidden /> Open classes</Link></header>
            {report.classInvoices.length ? <SimpleTable caption="Class invoice receivables and allocation reference" headers={[{ label: "Invoice" }, { label: "Date" }, { label: "Individual" }, { label: "Program" }, { label: "Invoice amount", numeric: true }, { label: "Agency split" }, { label: "Agency allocation", numeric: true }, { label: "Individual allocation", numeric: true }, { label: "Status" }]}>
              {report.classInvoices.map((row) => {
                const status = <div className="min-w-40"><p className="font-semibold text-[var(--color-ink)]">Reference only</p><p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Not actual cash income</p></div>;
                return <Tr key={row.id}><Td>{row.invoiceNumber}</Td><Td>{row.invoiceDate}</Td><Td>{row.individualName}</Td><Td>{row.programName ?? "Not linked"}</Td><Td numeric><Money value={row.grossAmount} /></Td><Td>{row.splitSource === "missing" && row.programId ? <button type="button" className="font-semibold text-[var(--color-danger)] underline" onClick={() => openProgramSplit({ individualId: row.individualId, programId: row.programId!, effectiveFrom: row.invoiceDate })}>Set effective split</button> : row.splitSource === "missing" ? <button type="button" className="font-semibold text-[var(--color-danger)] underline disabled:opacity-50" disabled={repairingClassProgramId !== null} onClick={() => openClassProgramRepair(row)}>Repair program link</button> : row.splitSource === "full_agency_default" ? "100% default" : percent(row.agencySharePercent)}</Td><Td numeric><Money value={row.agencyAmount} /></Td><Td numeric><Money value={row.individualExpense} /></Td><Td>{status}</Td></Tr>;
              })}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No issued class invoices in this month.</p>}
          </section>

          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Recorded receipts and other income</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">These are actual class receipts, reimbursements, custom-program receipts, and other payments entered outside the Google Sheet. Matching Sheet transactions stay visible without duplicating gross income; the recorded individual split still counts.</p></div><button type="button" className="btn btn-sm btn-primary" onClick={() => setModal("income")}><Plus className="h-4 w-4" aria-hidden /> Add income</button></header>
            {incomeHistory.length ? <SimpleTable caption="Recorded receipts and other income" headers={[{ label: "Date" }, { label: "Type" }, { label: "Individual / program" }, { label: "Reference" }, { label: "Gross", numeric: true }, { label: "Agency", numeric: true }, { label: "Individual expense", numeric: true }, { label: "Status" }, { label: "" }]}>
              {incomeHistory.map((row) => {
                const reportRow = manualIncomeById.get(row.id);
                const status = row.status === "void"
                  ? <span className="text-[var(--color-ink-faint)]">Voided</span>
                  : reportRow?.countSeparatelyReason && reportRow.matchedIncomeSource
                    ? <div className="min-w-52"><p className="font-semibold text-[var(--color-primary)]">Counted separately</p><p className="mt-0.5 text-xs"><AutomaticSourceLink source={reportRow.matchedIncomeSource} month={report.month} /></p><p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Reason: {reportRow.countSeparatelyReason}</p><button type="button" className="touch-target mt-1 inline-flex items-center px-1 text-xs font-semibold text-[var(--color-primary)] underline" onClick={() => setCountSeparatelyTarget({ id: row.id, label: `${SOURCE_LABEL[row.sourceType]} on ${row.serviceDate}`, source: reportRow.matchedIncomeSource!, action: "treat_as_same_payment", splitAlreadyCounted: reportRow.countedSplitExpense })}>Treat as same payment</button></div>
                    : reportRow?.countedInIncome === false && reportRow.matchedIncomeSource
                      ? row.sourceType === "class"
                        ? <div className="min-w-52"><p className="font-semibold text-[var(--color-primary)]">Linked to Sheet payment</p><p className="mt-0.5 text-xs">Gross comes from <AutomaticSourceLink source={reportRow.matchedIncomeSource} month={report.month} /></p><p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Individual split comes from this receipt</p><button type="button" className="touch-target mt-1 inline-flex items-center px-1 text-xs font-semibold text-[var(--color-primary)] underline" onClick={() => setCountSeparatelyTarget({ id: row.id, label: `${SOURCE_LABEL[row.sourceType]} on ${row.serviceDate}`, source: reportRow.matchedIncomeSource!, action: "count_separately", splitAlreadyCounted: reportRow.countedSplitExpense })}>Mark as separate payment</button></div>
                        : <div className="min-w-52"><p className="font-semibold text-[var(--color-danger)]">Income not counted</p><p className="mt-0.5 text-xs">Matches <AutomaticSourceLink source={reportRow.matchedIncomeSource} month={report.month} /></p>{reportRow.matchedSplitSource ? <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Individual split not counted; <AutomaticSourceLink source={reportRow.matchedSplitSource} month={report.month} /> owns it</p> : <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Individual split included</p>}<button type="button" className="touch-target mt-1 inline-flex items-center px-1 text-xs font-semibold text-[var(--color-primary)] underline" onClick={() => setCountSeparatelyTarget({ id: row.id, label: `${SOURCE_LABEL[row.sourceType]} on ${row.serviceDate}`, source: reportRow.matchedIncomeSource!, action: "count_separately", splitAlreadyCounted: reportRow.countedSplitExpense })}>Count separately</button></div>
                      : "Active";
                return <Tr key={row.id}><Td>{row.serviceDate}</Td><Td>{SOURCE_LABEL[row.sourceType]}</Td><Td>{[row.individualName, row.programName].filter(Boolean).join(" / ") || "General"}</Td><Td>{row.sourceRef ?? "-"}</Td><Td numeric><Money value={row.grossAmount} /></Td><Td numeric><Money value={row.agencyAmount} /></Td><Td numeric><Money value={row.individualAmount} /></Td><Td>{status}</Td><Td>{row.status === "active" ? <button type="button" className="btn btn-icon btn-ghost text-[var(--color-danger)]" aria-label="Void income" title="Void income" onClick={() => setVoidEntry(row)}><Trash2 className="h-4 w-4" aria-hidden /></button> : null}</Td></Tr>;
              })}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No receipts or other income recorded in this month.</p>}
          </section>
        </div>
      ) : null}

      {view === "rules" ? (
        <div className="space-y-5">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Individual program splits</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">The agency percentage for non-payroll income assigned to one individual and program.</p></div><button type="button" className="btn btn-sm btn-secondary" onClick={() => openProgramSplit()}><Plus className="h-4 w-4" aria-hidden /> Add split</button></header>
            {programTerms.length ? <SimpleTable caption="Individual program splits" headers={[{ label: "Individual" }, { label: "Program" }, { label: "Agency share" }, { label: "Starts" }, { label: "Ends" }, { label: "Authorized", numeric: true }, { label: "Remaining", numeric: true }]}>
              {programTerms.map((term) => <Tr key={term.id}><Td>{term.individualName}</Td><Td>{term.programName} ({term.programCode})</Td><Td>{percent(term.agencySharePercent)}</Td><Td>{term.effectiveFrom}</Td><Td>{term.effectiveTo ?? "Open"}</Td><Td numeric><Money value={term.authorizedDollars} /></Td><Td numeric><Money value={term.remainingDollars} /></Td></Tr>)}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No program splits have been saved.</p>}
          </section>
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5"><div><h2 className="display text-base font-semibold">Employee and individual pay rules</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Specific rules take priority over the employee&apos;s general agency-routed deal.</p></div><button type="button" className="btn btn-sm btn-secondary" onClick={() => openPayRule()}><Plus className="h-4 w-4" aria-hidden /> Add pay rule</button></header>
            {employeeTerms.length ? <SimpleTable caption="Employee and individual pay rules" headers={[{ label: "Employee" }, { label: "Individual" }, { label: "Employee share of base" }, { label: "Starts" }, { label: "Ends" }, { label: "Notes" }]}>
              {employeeTerms.map((term) => <Tr key={term.id}><Td>{term.employeeName}</Td><Td>{term.individualName}</Td><Td>{percent(term.employeeSharePercent)}</Td><Td>{term.effectiveFrom}</Td><Td>{term.effectiveTo ?? "Open"}</Td><Td>{term.notes ?? "-"}</Td></Tr>)}
            </SimpleTable> : <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-faint)]">No employee-person pay rules have been saved.</p>}
          </section>
        </div>
      ) : null}

      {modal === "income" ? <ModalShell title="Add actual income" onClose={() => setModal(null)}><IncomeForm month={report.month} options={options} onClose={() => setModal(null)} onSaved={saved} onOpenProgramSplit={(selection) => openProgramSplit(selection)} /></ModalShell> : null}
      {modal === "program-split" ? <ModalShell title="Set individual program split" onClose={() => setModal(null)}><ProgramSplitForm options={options} initial={splitRepair} onClose={() => setModal(null)} onSaved={saved} /></ModalShell> : null}
      {modal === "employee-term" ? <ModalShell title="Set employee pay rule" onClose={() => setModal(null)}><EmployeeTermForm options={options} initial={payRuleRepair} onClose={() => setModal(null)} onSaved={saved} /></ModalShell> : null}
      {voidEntry ? <ModalShell title="Void income entry" onClose={() => setVoidEntry(null)}><VoidIncomeForm entry={voidEntry} onClose={() => setVoidEntry(null)} onSaved={saved} /></ModalShell> : null}
      {countSeparatelyTarget ? <ModalShell title={countSeparatelyTarget.action === "treat_as_same_payment" ? "Treat as the same payment" : "Count as a separate payment"} onClose={() => setCountSeparatelyTarget(null)}><CountSeparatelyForm target={countSeparatelyTarget} month={report.month} onClose={() => setCountSeparatelyTarget(null)} onSaved={saved} /></ModalShell> : null}
      {classProgramRepairTarget ? <ModalShell title="Repair Classes budget link" onClose={() => repairingClassProgramId === null && setClassProgramRepairTarget(null)}><div className="space-y-4"><p className="text-sm leading-6 text-[var(--color-ink-soft)]">This repairs the shared Classes allowance for <strong className="text-[var(--color-ink)]">{classProgramRepairTarget.individualName}</strong> and reconciles every issued or voided invoice in that allowance with the unified budget history. Invoice dates and amounts do not change.</p>{actionError ? <Notice tone="error" action={<Link className="btn btn-sm btn-secondary" href="/settings#programs">Open program setup</Link>}>{actionError}</Notice> : null}<div className="flex justify-end gap-2 border-t border-[var(--color-rule)] pt-4"><button type="button" className="btn btn-secondary" disabled={repairingClassProgramId !== null} onClick={() => setClassProgramRepairTarget(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={repairingClassProgramId !== null} onClick={() => void repairClassProgram(classProgramRepairTarget)}>{repairingClassProgramId ? "Repairing..." : "Repair allowance and history"}</button></div></div></ModalShell> : null}
    </>
  );
}

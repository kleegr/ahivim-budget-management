import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  CalendarClock,
  CalendarX2,
  CircleDollarSign,
  Gauge,
  HandCoins,
  History,
  Landmark,
  PiggyBank,
  ReceiptText,
  Scale,
  TriangleAlert,
  UserRoundCheck,
  Users,
  Wrench,
  WalletCards,
} from "lucide-react";

export interface ReportPresentation {
  key: string;
  title: string;
  question: string;
  description: string;
  timeBasis: string;
  note?: string;
  columnLabels?: Record<string, string>;
  icon: LucideIcon;
  href?: string;
  ownerOnly?: boolean;
}

export interface ReportLibraryGroup {
  heading: string;
  description: string;
  reports: ReportPresentation[];
}

export const REPORT_LIBRARY: ReportLibraryGroup[] = [
  {
    heading: "Budgets",
    description: "Understand authorization use, renewal risk, and activity that lacks budget coverage.",
    reports: [
      {
        key: "budget-utilization",
        title: "Budget utilization",
        question: "How much is authorized, used, scheduled, and still available?",
        description: "Compares authorized, used, scheduled, and remaining hours for each person and program.",
        timeBasis: "Active authorization periods",
        note: "This report reflects authorization records loaded for reporting. Use Individuals for the current configured budget position.",
        icon: Gauge,
      },
      {
        key: "utilization-outliers",
        title: "Budget exceptions",
        question: "Who is materially behind pace or already over authorization?",
        description: "Surfaces reporting authorizations below the utilization threshold or beyond authorized hours.",
        timeBasis: "Active authorization periods, as of today",
        note: "This report reflects authorization records loaded for reporting. Use Individuals for the current configured budget position.",
        icon: TriangleAlert,
      },
      {
        key: "expiring-authorizations",
        title: "Renewal pipeline",
        question: "Which authorizations end soon, and how many hours remain?",
        description: "Lists authorizations ending within the selected number of days, including hours used and remaining.",
        timeBasis: "Upcoming renewal and period-end dates",
        note: "This report reflects authorization records loaded for reporting. Current budget renewal dates also appear in Individuals.",
        icon: CalendarClock,
      },
      {
        key: "billing-without-budget",
        title: "Billing without budget",
        question: "Which recorded services lacked authorization coverage for that exact Program on the service date?",
        description: "Checks each committed transaction against explicit authorization history and the effective Program budget available on its canonical service date.",
        timeBasis: "Canonical service date and authorization period then in force",
        note: "A later authorization cannot hide an earlier gap, and a budget for one Program cannot cover another.",
        icon: ReceiptText,
      },
      {
        key: "actual-vs-scheduled",
        title: "Actual versus scheduled",
        question: "Where does delivered activity differ from the current schedule?",
        description: "Compares scheduled hours and expected Employee base with committed transaction hours and recorded Employee base.",
        timeBasis: "Scheduled session date and transaction service date",
        note: "Actuals come directly from committed transactions, not reconciliation matches.",
        columnLabels: {
          scheduledInternal: "Scheduled Employee base",
          actualInternal: "Recorded Employee base",
          internalVariance: "Employee base variance",
        },
        icon: Scale,
      },
    ],
  },
  {
    heading: "Activity",
    description: "Trace what was recorded, what was scheduled, and where those sources do not line up.",
    reports: [
      {
        key: "transactions",
        title: "Transactions",
        question: "Which committed activity rows make up the recorded ledger?",
        description: "Shows canonical service date, people, Program, hours, each money stage, source check, and import provenance with an exact source link.",
        timeBasis: "Canonical service date",
        note: "Source check net repeats on its component rows and is never added as a generic total.",
        icon: BarChart3,
      },
      {
        key: "unbilled-schedules",
        title: "Scheduled not recorded",
        question: "Which planned visits are not linked to a recorded transaction?",
        description: "Lists unmatched planned sessions and their expected Employee base.",
        timeBasis: "Scheduled session date",
        note: "This is reconciliation link state, not independent proof that no corresponding transaction exists.",
        columnLabels: { expectedInternal: "Expected Employee base" },
        icon: CalendarX2,
      },
      {
        key: "unscheduled-billing",
        title: "Recorded not scheduled",
        question: "Which recorded transactions are not linked to a planned visit?",
        description: "Lists unmatched committed transactions with hours and Funder billed.",
        timeBasis: "Canonical service date",
        note: "This is reconciliation link state, not independent proof that no corresponding visit was scheduled.",
        columnLabels: { amount: "Funder billed" },
        icon: CalendarClock,
      },
      {
        key: "group-activity",
        title: "Group services",
        question: "Which group services were delivered and which group visits were planned?",
        description: "Shows delivered group-service sources without re-splitting their combined amount, plus planned group counts.",
        timeBasis: "Canonical service period and scheduled session date",
        columnLabels: { combinedAmount: "Funder billed" },
        icon: Users,
      },
      {
        key: "employee-activity",
        title: "Employee activity",
        question: "What recorded activity did each Employee deliver across the organization?",
        description: "Compares credited and physical hours, people served, Programs, group sessions, Funder billed, and Employee base by Employee.",
        timeBasis: "Canonical service date",
        note: "For group services, each member receives the full credited hours while employee time is counted once.",
        icon: UserRoundCheck,
      },
    ],
  },
  {
    heading: "Payroll and Money",
    description: "Keep source checks, obligations, recorded payments, credits, and agency results distinct.",
    reports: [
      {
        key: "payroll-checks",
        title: "Payroll checks",
        question: "Which payroll rows belong to each check, person, Program, and payment recipient?",
        description: "Shows committed transaction detail with payroll-period and check filters, additive totals, and an exact source-ledger link on every row.",
        timeBasis: "Payroll period and check date",
        note: "Check net repeats on source rows; the total counts each payment identity once, using the same deduplication rule as Transactions.",
        icon: WalletCards,
      },
      {
        key: "give-back",
        title: "Give-Back",
        question: "What do Employees owe back, what has been recorded, and what remains?",
        description: "Reads employee receivables from the canonical Money operations ledger without recomputing settlement math.",
        timeBasis: "Source obligation basis date and recorded settlement activity",
        icon: HandCoins,
      },
      {
        key: "agency-to-employee-payments",
        title: "Agency-to-Employee payments",
        question: "What does the Agency owe Employees, what has been paid, and what remains?",
        description: "Reads employee payables from the canonical Money operations ledger without recomputing settlement math.",
        timeBasis: "Source obligation basis date and recorded settlement activity",
        icon: Landmark,
      },
      {
        key: "individual-put-away",
        title: "Individual put-away",
        question: "What should be put away for each individual, what was recorded, and what remains?",
        description: "Uses the same dated plan state, corrections, and settlement events as Money operations for the selected month.",
        timeBasis: "Selected calendar month and the setup revision effective then",
        note: "Setup history begins in August 2026; earlier months disclose it as unavailable while retaining recorded ledger activity.",
        icon: PiggyBank,
      },
      {
        key: "credits",
        title: "Credits",
        question: "Which Money operations items were over-applied and now carry a credit?",
        description: "Shows canonical credit balances beside the original item and its recorded settlement activity.",
        timeBasis: "Source obligation basis date and recorded settlement activity",
        icon: CircleDollarSign,
      },
      {
        key: "agency-financials",
        title: "Agency Financials",
        question: "What actual income came in, what actual expenses apply, and what remains for the agency?",
        description: "Reconciles actual transaction and class receipts, other recorded income, approved monthly set-asides, verified withholding, employee shares, and individual shares. Issued but unpaid invoices remain receivables and are excluded.",
        timeBasis: "Selected month, using recorded actuals",
        note: "Owner only. Transaction income comes from imported actuals; projections never count as income.",
        icon: CircleDollarSign,
        href: "/reports/agency-financials",
        ownerOnly: true,
      },
      {
        key: "agency-earnings",
        title: "Billing spread by Program",
        question: "How does Funder billed divide between Employee base and Agency spread?",
        description: "Shows Funder billed, Employee base, and Agency spread as separate, reconciling values by Program.",
        timeBasis: "Canonical service date",
        note: "Deal cuts, give-backs, and payment balances are managed in Money operations.",
        columnLabels: {
          agencyGross: "Funder billed",
          internalAmount: "Employee base",
          agencyAdditional: "Agency spread",
        },
        icon: Landmark,
      },
      {
        key: "employee-payable",
        title: "Employee Base by recipient",
        question: "What Employee base was recorded, and who received the source payment?",
        description: "Groups recorded Employee base by Employee and payment recipient. Settlement status and Direct-check net remain in Money operations.",
        timeBasis: "Canonical service date",
        note: "For paid, partial, extra, and remaining balances, use Money operations.",
        columnLabels: {
          totalPayment: "Employee base",
          paidToEmployee: "Paid directly",
          payableByAgency: "Agency pays",
          unknownRecipient: "Recipient unresolved",
        },
        icon: HandCoins,
      },
    ],
  },
  {
    heading: "Data Quality",
    description: "Find configuration, check, import, identity, and audit records that need review.",
    reports: [
      {
        key: "missing-config",
        title: "Missing configuration",
        question: "Which authorized Individuals have no active Employee assignment?",
        description: "Separates staffing configuration gaps from Program rate gaps so each queue has one action.",
        timeBasis: "Current active authorization and assignment state",
        icon: Wrench,
      },
      {
        key: "missing-rates",
        title: "Missing rates",
        question: "Which active Programs have no rate schedule in force?",
        description: "Lists the Program configuration gaps that prevent trustworthy rate-based calculations.",
        timeBasis: "Current date and effective rate range",
        icon: TriangleAlert,
      },
      {
        key: "unverified-checks",
        title: "Unverified checks",
        question: "Which payroll-check facts still require verification?",
        description: "Shows identity and provenance only; unverified gross, net, and withholding are intentionally excluded.",
        timeBasis: "Check date, then period end, period begin, or recorded date",
        icon: WalletCards,
      },
      {
        key: "import-conflicts",
        title: "Import conflicts",
        question: "Which Sheet changes or missing rows remain open, and how were earlier conflicts resolved?",
        description: "Shows both the current decision queue and retained resolution history with exact source links where available.",
        timeBasis: "Conflict detection and resolution timestamps",
        icon: ReceiptText,
      },
      {
        key: "alias-decisions",
        title: "Alias and merge history",
        question: "How were imported names resolved, and which people were merged into which survivors?",
        description: "Shows alias decisions alongside merge survivor, folded source, repointed lineage, actor, date, and reason.",
        timeBasis: "Alias creation and immutable merge event timestamps",
        icon: UserRoundCheck,
      },
      {
        key: "audit-history",
        title: "Audit history",
        question: "Who changed what, when, and why?",
        description: "Shows the latest recorded changes, including actor, action, entity, and reason.",
        timeBasis: "Most recent 500 audit entries",
        icon: History,
      },
    ],
  },
];

export const REPORT_PRESENTATION = Object.fromEntries(
  REPORT_LIBRARY.flatMap((group) => group.reports.map((report) => [report.key, report])),
) as Record<string, ReportPresentation>;

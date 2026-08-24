import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Calculator,
  CalendarClock,
  CalendarX2,
  Gauge,
  HandCoins,
  History,
  Landmark,
  ReceiptText,
  Scale,
  TriangleAlert,
  UserRoundCheck,
  Users,
  Wrench,
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
}

export interface ReportLibraryGroup {
  heading: string;
  description: string;
  reports: ReportPresentation[];
}

export const REPORT_LIBRARY: ReportLibraryGroup[] = [
  {
    heading: "Budget decisions",
    description: "Find budgets that need intervention before hours expire or run out.",
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
        key: "actual-vs-scheduled",
        title: "Actual vs. scheduled",
        question: "Where does delivered activity differ from the current schedule?",
        description: "Compares scheduled hours and expected Employee base with delivered hours and recorded Employee base.",
        timeBasis: "All scheduled and committed activity",
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
    heading: "Money and planning",
    description: "Keep Funder billed, Employee base, Agency spread, and budget calculations distinct.",
    reports: [
      {
        key: "agency-earnings",
        title: "Billing spread by program",
        question: "How does Funder billed divide between Employee base and Agency spread?",
        description: "Shows Funder billed, Employee base, and Agency spread as separate, reconciling values by program.",
        timeBasis: "Service period begin date",
        note: "Deal cuts, give-backs, and payment balances are managed in Payments.",
        columnLabels: {
          agencyGross: "Funder billed",
          internalAmount: "Employee base",
          agencyAdditional: "Agency spread",
        },
        icon: Landmark,
      },
      {
        key: "employee-payable",
        title: "Employee base by recipient",
        question: "What Employee base was recorded, and who received the source payment?",
        description: "Groups recorded Employee base by employee and payment recipient. Settlement status and Direct-check net remain in Settlements.",
        timeBasis: "Service period begin date",
        note: "For paid, partial, extra, and remaining balances, use Settlements.",
        columnLabels: {
          totalPayment: "Employee base",
          paidToEmployee: "Paid directly",
          payableByAgency: "Agency pays",
          unknownRecipient: "Recipient unresolved",
        },
        icon: HandCoins,
      },
      {
        key: "program-totals",
        title: "Program performance",
        question: "Which programs carry the most people, hours, and Funder billed?",
        description: "Summarizes people, hours, Funder billed, Employee base, and Agency spread by program.",
        timeBasis: "All committed transactions",
        columnLabels: {
          agencyGross: "Funder billed",
          internalAmount: "Employee base",
          agencyAdditional: "Agency spread",
        },
        icon: BarChart3,
      },
      {
        key: "cuts-monthly",
        title: "Budget calculation audit",
        question: "How does each active budget move from annual gross through cuts to calculated net and the Annual set-aside (Masser)?",
        description: "Traces each active budget calculation from annual gross through configured cuts, calculated net, and the Annual set-aside (Masser).",
        timeBasis: "Current active budget revisions",
        columnLabels: {
          annualGross: "Annual budget gross",
          monthlyGross: "Monthly budget gross",
          finalGross: "Calculated gross",
          finalNet: "Calculated budget net",
          afterAll: "Annual set-aside (Masser)",
          spreadsheetValue: "Source value",
          difference: "Source difference",
        },
        icon: Calculator,
      },
    ],
  },
  {
    heading: "Operational control",
    description: "Resolve activity that does not line up between scheduling and billing.",
    reports: [
      {
        key: "unbilled-schedules",
        title: "Scheduled, not billed",
        question: "Which planned sessions have not produced a matching transaction?",
        description: "Lists scheduled sessions without matching billed transactions, including the schedule's expected Employee base.",
        timeBasis: "Scheduled session date",
        columnLabels: { expectedInternal: "Expected Employee base" },
        icon: CalendarX2,
      },
      {
        key: "unscheduled-billing",
        title: "Billed, not scheduled",
        question: "Which transactions have no matching planned session?",
        description: "Lists committed transactions without a matching schedule, including hours and Funder billed.",
        timeBasis: "Service period begin date",
        columnLabels: { amount: "Funder billed" },
        icon: ReceiptText,
      },
      {
        key: "group-activity",
        title: "Group activity",
        question: "Which group sessions were delivered, detected, and planned?",
        description: "Shows delivered and planned group sessions without splitting the combined Funder billed value.",
        timeBasis: "Service period and scheduled session dates",
        columnLabels: { combinedAmount: "Funder billed" },
        icon: Users,
      },
    ],
  },
  {
    heading: "Data integrity",
    description: "Trace configuration gaps, identity decisions, and changes to the system.",
    reports: [
      {
        key: "missing-config",
        title: "Configuration gaps",
        question: "Which active records are missing rates or employee assignments?",
        description: "Surfaces missing current rates and active authorizations without an employee assignment.",
        timeBasis: "Current configuration",
        icon: Wrench,
      },
      {
        key: "alias-decisions",
        title: "Name resolution history",
        question: "How were imported names resolved to canonical people?",
        description: "Shows imported spellings, canonical matches, approval status, and decision history.",
        timeBasis: "All recorded alias decisions",
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

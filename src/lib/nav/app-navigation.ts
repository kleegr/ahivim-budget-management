import type { AccountPresetId } from "@/lib/auth/account-presets";

export type NavigationGate = "resolved" | "manager" | "owner" | "activity-transactions" | "transactions" | "settlements" | "budgets" | "planning" | "employees" | "classes" | "documents" | "portal" | "agencies";

export interface NavigationAccess {
  role: string;
  accountPreset?: AccountPresetId | null;
  canSeeTransactions: boolean;
  canSeeSettlements: boolean;
  canSeeBudgets: boolean;
  canPlan: boolean;
  canSeeClassFinancials?: boolean;
  canSeeEmployees?: boolean;
  canEditDocuments: boolean;
  canUsePortal?: boolean;
  canManageAgencies?: boolean;
  /** Every gated destination stays hidden until capability lookup succeeds. */
  accessResolved: boolean;
}

export interface NavigationDestination {
  id: string;
  label: string;
  href: string;
  hint: string;
  keywords?: string;
  /** Route families represented by this destination in an expanded workspace. */
  activePrefixes?: readonly string[];
  gate?: NavigationGate;
}

export interface NavigationWorkspace {
  id: "overview" | "portal" | "people" | "activity" | "money";
  label: string;
  hint: string;
  activePrefixes: readonly string[];
  destinations: readonly NavigationDestination[];
}

export interface VisibleNavigationWorkspace extends Omit<NavigationWorkspace, "destinations"> {
  href: string;
  destinations: NavigationDestination[];
}

const WORKSPACES: readonly NavigationWorkspace[] = [
  {
    id: "overview",
    label: "Home",
    hint: "Start here",
    activePrefixes: ["/home", "/dashboard"],
    destinations: [
      {
        id: "overview-home",
        label: "Home",
        href: "/home",
        hint: "Start here",
        keywords: "home dashboard start",
        gate: "resolved",
      },
    ],
  },
  {
    id: "portal",
    label: "My portal",
    hint: "Your profiles, organizations, and approved information",
    activePrefixes: ["/portal"],
    destinations: [
      {
        id: "portal-home",
        label: "My portal",
        href: "/portal",
        hint: "Your profiles, organizations, and approved information",
        keywords: "parent guardian employee agency portal organization access",
        gate: "portal",
      },
    ],
  },
  {
    id: "people",
    label: "People & budgets",
    hint: "People, authorizations, staffing, and organizations",
    activePrefixes: ["/individuals", "/people", "/employees", "/agencies"],
    destinations: [
      {
        id: "budget-portfolio",
        label: "People & budgets",
        href: "/individuals",
        hint: "Authorized hours, usage, and renewals",
        keywords: "individuals people clients authorizations utilization renewals",
        gate: "budgets",
      },
      {
        id: "employees",
        label: "Employees",
        href: "/employees",
        hint: "Employees, assignments, and availability",
        keywords: "staff workers assignments schedules availability",
        gate: "employees",
      },
      {
        id: "agency-directory",
        label: "Agencies",
        href: "/agencies",
        hint: "Organizations, rosters, and operational activity",
        keywords: "agency provider organization roster individuals employees activity",
        gate: "agencies",
      },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    hint: "Transactions, schedules, matching, and source review",
    activePrefixes: [
      "/transactions",
      "/schedule",
      "/reconciliation",
      "/review",
      "/sync",
      "/imports",
      "/matches",
      "/exceptions",
      "/aliases",
    ],
    destinations: [
      {
        id: "transactions",
        label: "Transactions",
        href: "/transactions",
        hint: "Actual billing and payroll history",
        keywords: "transactions billing payroll checks ledger source actual activity",
        gate: "activity-transactions",
      },
      {
        id: "schedule",
        label: "Schedule",
        href: "/schedule",
        hint: "Plan who works with whom and when",
        keywords: "calendar planning sessions coverage assignments",
        gate: "planning",
      },
      {
        id: "activity-review",
        label: "Review & sync",
        href: "/review",
        hint: "Matching, imports, and source-data review",
        keywords: "reconciliation review sync import source conflicts matching",
        activePrefixes: [
          "/review",
          "/reconciliation",
          "/sync",
          "/imports",
          "/matches",
          "/exceptions",
          "/aliases",
        ],
        gate: "manager",
      },
    ],
  },
  {
    id: "money",
    label: "Money & reports",
    hint: "Amounts to action, financial setup, classes, and reporting",
    activePrefixes: ["/collections", "/settlements", "/calculations", "/projections", "/masser", "/reports", "/classes"],
    destinations: [
      {
        id: "money-overview",
        label: "Masser",
        href: "/masser",
        hint: "Money to collect, pay, and put away",
        keywords: "money collector receivable monthly check gross net reserve put away masser target",
        gate: "settlements",
      },
      {
        id: "financial-setup",
        label: "Financial setup",
        href: "/calculations",
        hint: "Rates, arrangements, sequential cuts, and approved amounts",
        keywords: "financial setup deals calculations cuts projections rates",
        gate: "manager",
      },
      {
        id: "agency-financials",
        label: "Agency financials",
        href: "/reports/agency-financials",
        hint: "Actual income, expenses, and agency result",
        keywords: "owner agency actual income expenses result profit",
        gate: "owner",
      },
      {
        id: "class-billing",
        label: "Classes",
        href: "/classes",
        hint: "Class budgets and invoices",
        keywords: "classes revenue invoice allowance reimbursement idgs",
        gate: "classes",
      },
      {
        id: "report-library",
        label: "Reports",
        href: "/reports",
        hint: "Answer a business question or export a result",
        keywords: "reports csv excel analysis export agency financials",
        gate: "manager",
      },
    ],
  },
];

const ADMIN_DESTINATIONS: readonly NavigationDestination[] = [
  {
    id: "role-preview",
    label: "Role preview",
    href: "/settings/role-preview",
    hint: "See and test every role-specific experience",
    keywords: "role preview sign in as test account permissions portal",
    gate: "owner",
  },
  {
    id: "agency-settings",
    label: "Agencies and roles",
    href: "/settings/agencies",
    hint: "Organizations, memberships, and portal assignments",
    keywords: "agency organization parent guardian employee staffing scheduler collector portal",
    gate: "agencies",
  },
  {
    id: "documents",
    label: "Documents",
    href: "/documents",
    hint: "Saved PDFs, direct editing and version history",
    keywords: "documents library pdf ocr scans cover sheets forms editor signature versions",
    gate: "documents",
  },
  {
    id: "settings",
    label: "Users & settings",
    href: "/settings",
    hint: "Users, account, programs, and rates",
    keywords: "password users access programs rates audit system",
  },
];

const ADVANCED_COMMANDS: readonly NavigationDestination[] = [
  {
    id: "billing-history",
    label: "Transactions",
    href: "/transactions",
    hint: "Actual billing and payroll history",
    keywords: "transactions billed ledger source",
    gate: "transactions",
  },
  {
    id: "annual-plans",
    label: "Financial setup",
    href: "/calculations",
    hint: "Expected monthly amounts, sequential cuts, and approved final",
    keywords: "budget planning financial calculations cuts projections",
    gate: "manager",
  },
  {
    id: "open-balances",
    label: "Payment ledger",
    href: "/settlements",
    hint: "Detailed payments, collections, set-asides, and credits",
    keywords: "settlements ledger owed receivable payable payment history",
    gate: "settlements",
  },
  {
    id: "schedule-matching",
    label: "Schedule matching",
    href: "/reconciliation",
    hint: "Compare scheduled work with billed activity",
    keywords: "reconciliation planned actual group review",
    gate: "manager",
  },
  {
    id: "data-review",
    label: "Data review",
    href: "/review",
    hint: "Optional source-data cleanup tools",
    keywords: "aliases matches exceptions reconcile cleanup",
    gate: "manager",
  },
  {
    id: "backup-imports",
    label: "Import a workbook",
    href: "/imports",
    hint: "Manual workbook upload and history",
    keywords: "xlsx workbook upload staging commit",
    gate: "manager",
  },
];

const REPORT_COMMANDS: readonly NavigationDestination[] = [
  {
    id: "report-agency-financials",
    label: "Report: Agency financials",
    href: "/reports/agency-financials",
    hint: "Actual income, expenses, and agency result",
    keywords: "owner actual income expenses profit taxes payroll classes",
    gate: "owner",
  },
  {
    id: "report-budget-utilization",
    label: "Report: Budget utilization",
    href: "/reports/budget-utilization",
    hint: "Authorized, used and scheduled hours",
    keywords: "pace behind budget health",
    gate: "manager",
  },
  {
    id: "report-expiring-authorizations",
    label: "Report: Expiring authorizations",
    href: "/reports/expiring-authorizations",
    hint: "Renewals approaching their end date",
    keywords: "renew lapse expiration 60 days",
    gate: "manager",
  },
  {
    id: "report-utilization-outliers",
    label: "Report: Utilization outliers",
    href: "/reports/utilization-outliers",
    hint: "Under-used and over-used budgets",
    keywords: "over authorization behind outlier",
    gate: "manager",
  },
  {
    id: "report-agency-earnings",
    label: "Report: Agency spread",
    href: "/reports/agency-earnings",
    hint: "Funder billed less employee base",
    keywords: "agency difference margin earnings money",
    gate: "manager",
  },
  {
    id: "report-employee-payable",
    label: "Report: Employee payments",
    href: "/reports/employee-payable",
    hint: "Payment attribution by employee",
    keywords: "owed payable checks payroll",
    gate: "manager",
  },
];

const EXTERNAL_ACCOUNT_PRESETS = new Set<AccountPresetId>([
  "individual_parent",
  "employee",
  "agency",
  "agency_scheduler",
  "agency_staffing_manager",
  "agency_collector",
]);

function usesExternalLanding(access: NavigationAccess): boolean {
  if (access.role !== "viewer" || !access.canUsePortal) return false;
  if (access.accountPreset) return EXTERNAL_ACCOUNT_PRESETS.has(access.accountPreset);

  // Legacy portal accounts predate persisted presets. Treat a viewer with a
  // portal identity and no internal money/budget/document workspace as an
  // external account, including agency planners whose only extra area is the
  // agency-scoped Schedule.
  return !access.canSeeTransactions
    && !access.canSeeSettlements
    && !access.canSeeBudgets
    && !(access.canSeeClassFinancials ?? false)
    && !access.canEditDocuments;
}

function allowed(gate: NavigationGate | undefined, access: NavigationAccess): boolean {
  if (!gate) return true;
  if (!access.accessResolved) return false;
  if (gate === "resolved") return true;
  if (gate === "owner") return access.role === "admin";
  if (gate === "manager") return access.role === "manager" || access.role === "admin";
  if (gate === "activity-transactions") {
    return access.canSeeTransactions
      && (access.role === "manager" || access.role === "admin" || !access.canSeeSettlements);
  }
  if (gate === "transactions") return access.canSeeTransactions;
  if (gate === "settlements") return access.canSeeSettlements;
  if (gate === "planning") return access.canPlan;
  if (gate === "classes") return access.canSeeClassFinancials ?? false;
  if (gate === "documents") return access.canEditDocuments;
  if (gate === "portal") return access.role === "viewer" && (access.canUsePortal ?? false);
  if (gate === "agencies") return access.canManageAgencies ?? false;
  if (gate === "employees") {
    if (access.canSeeEmployees !== undefined) return access.canSeeEmployees;
    return access.role === "manager" || access.role === "admin" || access.canPlan;
  }
  return access.canSeeBudgets;
}

export function getVisibleWorkspaces(access: NavigationAccess): VisibleNavigationWorkspace[] {
  return WORKSPACES.flatMap((workspace) => {
    if (workspace.id === "overview" && usesExternalLanding(access)) return [];
    const destinations = workspace.destinations.filter((destination) => allowed(destination.gate, access));
    if (destinations.length === 0) return [];
    return [{ ...workspace, href: destinations[0].href, destinations }];
  });
}

export function getVisibleAdminDestinations(access: NavigationAccess): NavigationDestination[] {
  return ADMIN_DESTINATIONS
    .filter((destination) => allowed(destination.gate, access))
    .map((destination) => {
      if (destination.id !== "settings" || access.role === "admin") return destination;
      return access.role === "manager"
        ? { ...destination, label: "Settings", hint: "Programs and account settings" }
        : { ...destination, label: "My account", hint: "Password and account details" };
    });
}

export function pathMatches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function shouldTrackNavigation(pathname: string, href: string): boolean {
  return href !== pathname;
}

export function workspaceIsActive(pathname: string, workspace: NavigationWorkspace): boolean {
  return workspace.activePrefixes.some((prefix) => pathMatches(pathname, prefix));
}

export function destinationIsActive(pathname: string, destination: NavigationDestination): boolean {
  const prefixes = destination.activePrefixes ?? [destination.href];
  return prefixes.some((prefix) => pathMatches(pathname, prefix));
}

export function getCommandDestinations(access: NavigationAccess): NavigationDestination[] {
  const workspaces = getVisibleWorkspaces(access);
  const items: NavigationDestination[] = [];
  const seen = new Set<string>();

  for (const workspace of workspaces) {
    const landing = workspace.destinations[0];
    items.push({
      ...landing,
      id: `workspace-${workspace.id}`,
      label: workspace.label,
      hint: workspace.hint,
      keywords: `${landing.keywords ?? ""} ${workspace.destinations.map((item) => item.label).join(" ")}`,
    });
    seen.add(landing.href);

    for (const destination of workspace.destinations.slice(1)) {
      if (seen.has(destination.href)) continue;
      items.push(destination);
      seen.add(destination.href);
    }
  }

  for (const destination of [
    ...getVisibleAdminDestinations(access),
    ...ADVANCED_COMMANDS.filter((item) => allowed(item.gate, access)),
    ...REPORT_COMMANDS.filter((item) => allowed(item.gate, access)),
  ]) {
    if (seen.has(destination.href)) continue;
    items.push(destination);
    seen.add(destination.href);
  }

  return items;
}

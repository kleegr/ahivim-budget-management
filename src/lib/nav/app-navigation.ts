export type NavigationGate = "manager" | "owner-transactions" | "transactions" | "settlements" | "budgets" | "planning" | "employees" | "classes" | "documents" | "portal" | "agencies";

export interface NavigationAccess {
  role: string;
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
  gate?: NavigationGate;
}

export interface NavigationWorkspace {
  id: "overview" | "portal" | "transactions" | "budgets" | "activity" | "payroll" | "employees" | "classes" | "reports";
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
        gate: "manager",
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
    id: "transactions",
    label: "Transactions",
    hint: "Actual billing and payroll history",
    activePrefixes: ["/transactions"],
    destinations: [
      {
        id: "transactions",
        label: "Transactions",
        href: "/transactions",
        hint: "Actual billing and payroll history",
        keywords: "transactions billing payroll checks ledger source actual activity",
        gate: "owner-transactions",
      },
    ],
  },
  {
    id: "budgets",
    label: "People & budgets",
    hint: "People, authorized hours, usage, and renewals",
    activePrefixes: ["/individuals", "/people"],
    destinations: [
      {
        id: "budget-portfolio",
        label: "People & budgets",
        href: "/individuals",
        hint: "People, authorized hours, usage, and renewals",
        keywords: "individuals people clients authorizations utilization",
        gate: "budgets",
      },
    ],
  },
  {
    id: "activity",
    label: "Schedule",
    hint: "Plan who works with whom and when",
    activePrefixes: ["/schedule"],
    destinations: [
      {
        id: "schedule",
        label: "Schedule",
        href: "/schedule",
        hint: "Plan who works with whom and when",
        keywords: "calendar planning sessions coverage assignments",
        gate: "planning",
      },
    ],
  },
  {
    id: "payroll",
    label: "Masser",
    hint: "Employee collections and individual set-asides",
    activePrefixes: ["/collections", "/settlements", "/calculations", "/projections", "/masser"],
    destinations: [
      {
        id: "collections",
        label: "Masser",
        href: "/masser",
        hint: "Employee collections and individual set-asides",
        keywords: "money collector receivable monthly check gross net reserve put away masser target",
        gate: "settlements",
      },
    ],
  },
  {
    id: "employees",
    label: "Employees",
    hint: "Employees, assignments, and pay arrangements",
    activePrefixes: ["/employees"],
    destinations: [
      {
        id: "employees",
        label: "Employees",
        href: "/employees",
        hint: "Employees, assignments, and pay arrangements",
        keywords: "staff workers assignments deals checks",
        gate: "employees",
      },
    ],
  },
  {
    id: "classes",
    label: "Classes",
    hint: "Class budgets and invoices",
    activePrefixes: ["/classes"],
    destinations: [
      {
        id: "class-billing",
        label: "Classes",
        href: "/classes",
        hint: "Class budgets and invoices",
        keywords: "classes revenue invoice allowance reimbursement idgs",
        gate: "classes",
      },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    hint: "View and export reports",
    activePrefixes: ["/reports"],
    destinations: [
      {
        id: "report-library",
        label: "Report library",
        href: "/reports",
        hint: "View and export reports",
        keywords: "csv excel analysis export",
        gate: "manager",
      },
    ],
  },
];

const ADMIN_DESTINATIONS: readonly NavigationDestination[] = [
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
  {
    id: "sheet-sync",
    label: "Google Sheet",
    href: "/sync",
    hint: "Bring in the latest Google Sheet information",
    keywords: "sheet sync source history conflicts",
    gate: "manager",
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

function allowed(gate: NavigationGate | undefined, access: NavigationAccess): boolean {
  if (!gate) return true;
  if (!access.accessResolved) return false;
  if (gate === "manager") return access.role === "manager" || access.role === "admin";
  if (gate === "owner-transactions") return access.role === "admin" && access.canSeeTransactions;
  if (gate === "transactions") return access.canSeeTransactions;
  if (gate === "settlements") return access.canSeeSettlements;
  if (gate === "planning") return access.canPlan;
  if (gate === "classes") return access.canSeeClassFinancials ?? false;
  if (gate === "documents") return access.canEditDocuments;
  if (gate === "portal") return access.canUsePortal ?? false;
  if (gate === "agencies") return access.canManageAgencies ?? false;
  if (gate === "employees") {
    if (access.canSeeEmployees !== undefined) return access.canSeeEmployees;
    return access.role === "manager" || access.role === "admin" || !access.canPlan || access.canSeeTransactions || access.canSeeSettlements;
  }
  return access.canSeeBudgets;
}

export function getVisibleWorkspaces(access: NavigationAccess): VisibleNavigationWorkspace[] {
  return WORKSPACES.flatMap((workspace) => {
    const destinations = workspace.destinations.filter((destination) => allowed(destination.gate, access));
    if (destinations.length === 0) return [];
    return [{ ...workspace, href: destinations[0].href, destinations }];
  });
}

export function getVisibleAdminDestinations(access: NavigationAccess): NavigationDestination[] {
  return ADMIN_DESTINATIONS.filter((destination) => allowed(destination.gate, access));
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
  return pathMatches(pathname, destination.href);
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

export type NavigationGate = "manager" | "transactions" | "settlements";

export interface NavigationAccess {
  role: string;
  canSeeTransactions: boolean;
  canSeeSettlements: boolean;
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
  id: "overview" | "budgets" | "payroll" | "activity" | "review" | "reports";
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
    label: "Overview",
    hint: "Today's priorities and portfolio health",
    activePrefixes: ["/home", "/dashboard"],
    destinations: [
      {
        id: "overview-home",
        label: "Overview",
        href: "/home",
        hint: "Today's priorities and portfolio health",
        keywords: "home dashboard attention start",
        gate: "manager",
      },
    ],
  },
  {
    id: "budgets",
    label: "Budgets",
    hint: "Authorizations, pace, annual plans and set-asides",
    activePrefixes: ["/individuals", "/people", "/calculations", "/projections", "/masser"],
    destinations: [
      {
        id: "budget-portfolio",
        label: "Portfolio",
        href: "/individuals",
        hint: "Authorized hours, usage and renewals",
        keywords: "individuals people clients authorizations utilization",
      },
      {
        id: "annual-plans",
        label: "Annual plans",
        href: "/calculations",
        hint: "Plan inputs, deductions and projected net",
        keywords: "financial calculations cuts projections",
        gate: "manager",
      },
      {
        id: "masser-set-asides",
        label: "Masser set-asides",
        href: "/masser",
        hint: "Annual targets and the portfolio board",
        keywords: "masser annual reserve set aside board",
        gate: "manager",
      },
    ],
  },
  {
    id: "payroll",
    label: "Payroll",
    hint: "Employee deals, open balances and payment history",
    activePrefixes: ["/settlements", "/employees"],
    destinations: [
      {
        id: "open-balances",
        label: "Open balances",
        href: "/settlements",
        hint: "Payouts, give-backs, set-asides and credits",
        keywords: "settlements ledger owed receivable payable payment history",
        gate: "settlements",
      },
      {
        id: "employees",
        label: "Employees",
        href: "/employees",
        hint: "Deals, checks, activity and people served",
        keywords: "staff workers deal terms checks",
      },
    ],
  },
  {
    id: "activity",
    label: "Service activity",
    hint: "Billed work, planned sessions and matching",
    activePrefixes: ["/transactions", "/schedule", "/reconciliation"],
    destinations: [
      {
        id: "billed-ledger",
        label: "Billed ledger",
        href: "/transactions",
        hint: "Committed service and payroll rows",
        keywords: "transactions actual billed source truth",
        gate: "transactions",
      },
      {
        id: "schedule",
        label: "Schedule",
        href: "/schedule",
        hint: "Plan one-time and recurring sessions",
        keywords: "calendar planning sessions",
        gate: "manager",
      },
      {
        id: "schedule-matching",
        label: "Schedule matching",
        href: "/reconciliation",
        hint: "Match planned sessions to billed activity",
        keywords: "reconciliation planned actual group review",
        gate: "manager",
      },
    ],
  },
  {
    id: "review",
    label: "Review",
    hint: "Resolve decisions the system cannot make alone",
    activePrefixes: ["/review", "/aliases", "/matches", "/exceptions"],
    destinations: [
      {
        id: "review-inbox",
        label: "Review inbox",
        href: "/review",
        hint: "All decisions waiting for a person",
        keywords: "inbox attention unresolved",
        gate: "manager",
      },
      {
        id: "name-spellings",
        label: "Name spellings",
        href: "/aliases",
        hint: "Approve imported names and aliases",
        keywords: "identity names aliases spelling",
        gate: "manager",
      },
      {
        id: "duplicate-people",
        label: "Duplicate people",
        href: "/matches",
        hint: "Review possible identity matches",
        keywords: "merge duplicates people matches",
        gate: "manager",
      },
      {
        id: "data-exceptions",
        label: "Data exceptions",
        href: "/exceptions",
        hint: "Unexpected rates and unresolved source values",
        keywords: "warnings rates programs invalid rows",
        gate: "manager",
      },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    hint: "Analysis, drill-downs and exports",
    activePrefixes: ["/reports"],
    destinations: [
      {
        id: "report-library",
        label: "Report library",
        href: "/reports",
        hint: "Analysis, drill-downs and exports",
        keywords: "csv excel analysis export",
        gate: "manager",
      },
    ],
  },
];

const ADMIN_DESTINATIONS: readonly NavigationDestination[] = [
  {
    id: "settings",
    label: "Settings and access",
    href: "/settings",
    hint: "Account, permissions, programs and rates",
    keywords: "password users access programs rates audit system",
  },
  {
    id: "sheet-sync",
    label: "Data source",
    href: "/sync",
    hint: "Google Sheet freshness, runs and conflicts",
    keywords: "sheet sync source history conflicts",
    gate: "manager",
  },
  {
    id: "backup-imports",
    label: "Backup imports",
    href: "/imports",
    hint: "Manual workbook uploads and import history",
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
  if (gate === "manager") return access.role === "manager" || access.role === "admin";
  if (gate === "transactions") return access.canSeeTransactions;
  return access.canSeeSettlements;
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

  for (const destination of [...getVisibleAdminDestinations(access), ...REPORT_COMMANDS.filter((item) => allowed(item.gate, access))]) {
    if (seen.has(destination.href)) continue;
    items.push(destination);
    seen.add(destination.href);
  }

  return items;
}

import type { AccountPresetId } from "@/lib/auth/account-presets";

export interface RoleHomeCapabilities {
  canSeeBudgets: boolean;
  canSeeEmployees: boolean;
  canSeeTransactions: boolean;
  canPlan: boolean;
  canSeeSettlements: boolean;
  canSeeClassFinancials: boolean;
  canEditDocuments: boolean;
  canUsePortal: boolean;
}

export type RoleHomeActionId =
  | "people"
  | "employees"
  | "transactions"
  | "schedule"
  | "masser"
  | "settlements"
  | "classes"
  | "documents"
  | "portal"
  | "account";

export interface RoleHomeAction {
  id: RoleHomeActionId;
  label: string;
  description: string;
  href: string;
}

export interface RoleHomeDefinition {
  eyebrow: string;
  title: string;
  description: string;
  actions: RoleHomeAction[];
}

const ACTIONS: Record<RoleHomeActionId, RoleHomeAction> = {
  people: {
    id: "people",
    label: "People & budgets",
    description: "Review authorizations, usage, renewals, and the next action for each person.",
    href: "/individuals",
  },
  employees: {
    id: "employees",
    label: "Employees",
    description: "Open employee profiles, assignments, availability, and upcoming work.",
    href: "/employees",
  },
  transactions: {
    id: "transactions",
    label: "Transactions",
    description: "Review committed service, payroll, checks, and exact source rows.",
    href: "/transactions",
  },
  schedule: {
    id: "schedule",
    label: "Schedule",
    description: "Plan visits, resolve staffing conflicts, and review budget coverage.",
    href: "/schedule",
  },
  masser: {
    id: "masser",
    label: "Masser",
    description: "Work the checks, collections, payments, put-away, credit, and correction queues.",
    href: "/masser",
  },
  settlements: {
    id: "settlements",
    label: "Payment ledger",
    description: "Review detailed obligations, events, balances, and history.",
    href: "/settlements",
  },
  classes: {
    id: "classes",
    label: "Classes",
    description: "Prepare allowances, monthly invoices, cover sheets, and saved output.",
    href: "/classes",
  },
  documents: {
    id: "documents",
    label: "Documents",
    description: "Open saved PDFs, forms, overlays, versions, and drafts.",
    href: "/documents",
  },
  portal: {
    id: "portal",
    label: "My portal",
    description: "Open the people, agency information, statements, and schedule shared with you.",
    href: "/portal",
  },
  account: {
    id: "account",
    label: "My account",
    description: "Change your password and review your account details.",
    href: "/settings",
  },
};

const COPY: Partial<Record<AccountPresetId, Omit<RoleHomeDefinition, "actions">>> = {
  budget_planner: {
    eyebrow: "Budget planner",
    title: "Budget planning home",
    description: "Keep authorizations current, hours on pace, and upcoming schedules inside the approved plan.",
  },
  staffing_manager: {
    eyebrow: "Staffing manager",
    title: "Staffing home",
    description: "Put the right employee on each visit and resolve assignment, availability, and time-off conflicts.",
  },
  money_collector: {
    eyebrow: "Money collector",
    title: "Money operations home",
    description: "Finish the next collection, payment, or individual put-away action and keep its history complete.",
  },
  class_billing: {
    eyebrow: "Class billing",
    title: "Class billing home",
    description: "Move allowances and monthly invoices from draft through preview, issue, cover sheet, and saved output.",
  },
  custom_access: {
    eyebrow: "Custom access",
    title: "Your home",
    description: "Your owner selected the workspaces below for this account.",
  },
};

const PRIORITY: Partial<Record<AccountPresetId, RoleHomeActionId[]>> = {
  budget_planner: ["people", "schedule", "employees"],
  staffing_manager: ["schedule", "employees"],
  money_collector: ["masser", "settlements", "transactions"],
  class_billing: ["classes", "documents"],
};

function permittedActions(capabilities: RoleHomeCapabilities): Set<RoleHomeActionId> {
  const ids = new Set<RoleHomeActionId>();
  if (capabilities.canSeeBudgets) ids.add("people");
  if (capabilities.canSeeEmployees) ids.add("employees");
  if (capabilities.canSeeTransactions) ids.add("transactions");
  if (capabilities.canPlan) ids.add("schedule");
  if (capabilities.canSeeSettlements) {
    ids.add("masser");
    ids.add("settlements");
  }
  if (capabilities.canSeeClassFinancials) ids.add("classes");
  if (capabilities.canEditDocuments) ids.add("documents");
  if (capabilities.canUsePortal) ids.add("portal");
  ids.add("account");
  return ids;
}

/** Build a role-led Home while still honoring every per-account adjustment. */
export function buildRoleHomeDefinition(
  preset: AccountPresetId,
  capabilities: RoleHomeCapabilities,
): RoleHomeDefinition {
  const allowed = permittedActions(capabilities);
  const preferred = PRIORITY[preset] ?? [];
  const fallback: RoleHomeActionId[] = [
    "people",
    "employees",
    "transactions",
    "schedule",
    "masser",
    "settlements",
    "classes",
    "documents",
    "portal",
    "account",
  ];
  const ordered = [...new Set([...preferred, ...fallback])]
    .filter((id) => allowed.has(id))
    .map((id) => ACTIONS[id]);
  const copy = COPY[preset] ?? COPY.custom_access!;
  return { ...copy, actions: ordered };
}

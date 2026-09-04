import type { Role } from "./session";
import type { AgencyPortalRole, PortalCapability } from "./portal-access";
import type { UserAccessConfig } from "./users";
import {
  BUDGET_PLANNER_ACCESS,
  CLASS_BILLING_ACCESS,
  COLLECTIONS_ACCESS,
  PORTAL_ONLY_ACCESS,
  STAFFING_MANAGER_ACCESS,
} from "./access-presets";

export { PORTAL_ONLY_ACCESS } from "./access-presets";

export const ACCOUNT_PRESET_IDS = [
  "owner",
  "office_manager",
  "budget_planner",
  "staffing_manager",
  "money_collector",
  "class_billing",
  "individual_parent",
  "employee",
  "agency",
  "agency_scheduler",
  "agency_staffing_manager",
  "agency_collector",
  "custom_access",
] as const;

export type AccountPresetId = (typeof ACCOUNT_PRESET_IDS)[number];

export type AccountPresetBinding =
  | { kind: "none" }
  | { kind: "owner" }
  | {
      kind: "individual";
      defaultCapabilityGrants: PortalCapability[];
    }
  | { kind: "employee" }
  | { kind: "agency"; role: AgencyPortalRole };

export interface AccountPresetDefinition {
  id: AccountPresetId;
  label: string;
  description: string;
  role: Role;
  access?: UserAccessConfig;
  binding: AccountPresetBinding;
}

export const ACCOUNT_PRESETS: readonly AccountPresetDefinition[] = [
  {
    id: "owner",
    label: "Owner",
    description: "Everything in the agency, including portals, users, and system settings.",
    role: "admin",
    binding: { kind: "owner" },
  },
  {
    id: "office_manager",
    label: "Office manager",
    description: "All everyday work, reports, budgets, and financials. Cannot manage user accounts.",
    role: "manager",
    binding: { kind: "none" },
  },
  {
    id: "budget_planner",
    label: "Budget planner",
    description: "Calendar, assignments, and authorized hours without financial information.",
    role: "viewer",
    access: BUDGET_PLANNER_ACCESS,
    binding: { kind: "none" },
  },
  {
    id: "staffing_manager",
    label: "Staffing manager",
    description: "Employees, assignments, and schedules without budgets or financial information.",
    role: "viewer",
    access: STAFFING_MANAGER_ACCESS,
    binding: { kind: "none" },
  },
  {
    id: "money_collector",
    label: "Money collector",
    description: "Masser, payroll checks, collections, and individual put-away.",
    role: "viewer",
    access: COLLECTIONS_ACCESS,
    binding: { kind: "none" },
  },
  {
    id: "class_billing",
    label: "Class billing",
    description: "Class allowances, invoices, forms, and document editing.",
    role: "viewer",
    access: CLASS_BILLING_ACCESS,
    binding: { kind: "none" },
  },
  {
    id: "individual_parent",
    label: "Individual or parent",
    description: "A portal limited to one directly linked individual.",
    role: "viewer",
    access: PORTAL_ONLY_ACCESS,
    binding: {
      kind: "individual",
      defaultCapabilityGrants: [
        "financials.self.billed_totals.read",
        "financials.self.cuts_set_asides.read",
      ],
    },
  },
  {
    id: "employee",
    label: "Employee",
    description: "The employee's own checks, withholding, give-back, and balance.",
    role: "viewer",
    access: PORTAL_ONLY_ACCESS,
    binding: { kind: "employee" },
  },
  {
    id: "agency",
    label: "Agency or provider",
    description: "Approved agency rollups for the agency's linked roster.",
    role: "viewer",
    access: PORTAL_ONLY_ACCESS,
    binding: { kind: "agency", role: "agency" },
  },
  {
    id: "agency_scheduler",
    label: "Agency scheduler",
    description: "Agency-scoped hours and schedule management without money.",
    role: "viewer",
    access: PORTAL_ONLY_ACCESS,
    binding: { kind: "agency", role: "scheduler" },
  },
  {
    id: "agency_staffing_manager",
    label: "Agency staffing manager",
    description: "Agency-scoped employee assignments and schedules without money.",
    role: "viewer",
    access: PORTAL_ONLY_ACCESS,
    binding: { kind: "agency", role: "staffing_manager" },
  },
  {
    id: "agency_collector",
    label: "Agency collector",
    description: "Agency-scoped collection and set-aside summaries.",
    role: "viewer",
    access: PORTAL_ONLY_ACCESS,
    binding: { kind: "agency", role: "collector" },
  },
  {
    id: "custom_access",
    label: "Custom access",
    description: "Starts with no access and can be tailored for an unusual internal responsibility.",
    role: "viewer",
    access: PORTAL_ONLY_ACCESS,
    binding: { kind: "none" },
  },
];

export function isAccountPresetId(value: string): value is AccountPresetId {
  return (ACCOUNT_PRESET_IDS as readonly string[]).includes(value);
}

export function getAccountPreset(value: string): AccountPresetDefinition | null {
  if (!isAccountPresetId(value)) return null;
  return ACCOUNT_PRESETS.find((preset) => preset.id === value) ?? null;
}

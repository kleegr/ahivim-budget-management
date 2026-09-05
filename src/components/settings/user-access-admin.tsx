"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, Check, Copy, Eye, EyeOff, GraduationCap, LogIn, Plus, UsersRound, WalletCards, X } from "lucide-react";
import {
  BUDGET_PLANNER_ACCESS,
  CLASS_BILLING_ACCESS,
  COLLECTIONS_ACCESS,
  STAFFING_MANAGER_ACCESS,
} from "@/lib/auth/access-presets";
import {
  ACCOUNT_PRESETS,
  getAccountPreset,
  type AccountPresetId,
} from "@/lib/auth/account-presets";
import {
  PORTAL_CAPABILITIES,
  portalCapabilitiesForRole,
  portalCapabilityAllowedForRole,
  type PortalCapability,
  type PortalRole,
} from "@/lib/auth/portal-access";
import { ROLE_PREVIEW_DETAILS } from "@/lib/auth/role-preview";
import type { UserAccessConfig } from "@/lib/auth/users";

/**
 * Administrator user + access management.
 *
 * Beyond creating accounts and setting roles, this is where an admin hands out
 * SCOPED logins: a viewer who sees only certain individuals and/or employees
 * (plus everyone connected to them), with an optional lock on Transactions. Every
 * choice here is re-enforced on the server — the UI just makes it easy to set.
 */

type Option = { id: string; name: string };

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  required,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
  minLength?: number;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const actionLabel = visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`;

  return (
    <div className="text-sm">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <div className="relative mt-1">
        <input
          id={id}
          required={required}
          minLength={minLength}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="new-password"
          className="input w-full pr-11 text-sm"
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={actionLabel}
          aria-pressed={visible}
          aria-controls={id}
          title={actionLabel}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-primary)]"
        >
          {visible ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  accessScope: "full" | "scoped";
  seeAllIndividuals: boolean;
  seeAllEmployees: boolean;
  canSeeTransactions: boolean;
  canSeeMoney: boolean;
  canSeeHours: boolean;
  canSeeBilledAmounts: boolean;
  canSeeEmployeeAmounts: boolean;
  canSeeAgencySpread: boolean;
  canSeeCheckGross: boolean;
  canSeeCheckNet: boolean;
  canSeeTaxes: boolean;
  canSeeBudgets: boolean;
  canSeeEmployeeDeals: boolean;
  canSeeSettlements: boolean;
  canManageSettlements: boolean;
  canSeeClassFinancials: boolean;
  canManageClassInvoices: boolean;
  canViewDocuments: boolean;
  canEditDocuments: boolean;
  canPlan: boolean;
  canManagePlanning: boolean;
  accountPreset: AccountPresetId | null;
  portalManaged: boolean;
  individualCount: number;
  employeeCount: number;
}

interface AccessState {
  accessScope: "full" | "scoped";
  seeAllIndividuals: boolean;
  seeAllEmployees: boolean;
  canSeeTransactions: boolean;
  canSeeMoney: boolean;
  canSeeHours: boolean;
  canSeeBilledAmounts: boolean;
  canSeeEmployeeAmounts: boolean;
  canSeeAgencySpread: boolean;
  canSeeCheckGross: boolean;
  canSeeCheckNet: boolean;
  canSeeTaxes: boolean;
  canSeeBudgets: boolean;
  canSeeEmployeeDeals: boolean;
  canSeeSettlements: boolean;
  canManageSettlements: boolean;
  canSeeClassFinancials: boolean;
  canManageClassInvoices: boolean;
  canViewDocuments: boolean;
  canEditDocuments: boolean;
  canPlan: boolean;
  canManagePlanning: boolean;
  individualIds: Set<string>;
  employeeIds: Set<string>;
}

const emptyAccess = (): AccessState => ({
  accessScope: "scoped",
  seeAllIndividuals: false,
  seeAllEmployees: false,
  canSeeTransactions: false,
  canSeeMoney: false,
  canSeeHours: false,
  canSeeBilledAmounts: false,
  canSeeEmployeeAmounts: false,
  canSeeAgencySpread: false,
  canSeeCheckGross: false,
  canSeeCheckNet: false,
  canSeeTaxes: false,
  canSeeBudgets: false,
  canSeeEmployeeDeals: false,
  canSeeSettlements: false,
  canManageSettlements: false,
  canSeeClassFinancials: false,
  canManageClassInvoices: false,
  canViewDocuments: false,
  canEditDocuments: false,
  canPlan: false,
  canManagePlanning: false,
  individualIds: new Set(),
  employeeIds: new Set(),
});

const cloneAccess = (value: AccessState): AccessState => ({
  ...value,
  individualIds: new Set(value.individualIds),
  employeeIds: new Set(value.employeeIds),
});

const accessFromPreset = (preset: UserAccessConfig): AccessState => ({
  ...preset,
  individualIds: new Set(preset.individualIds),
  employeeIds: new Set(preset.employeeIds),
});

const accessToBody = (a: AccessState) => ({
  accessScope: a.accessScope,
  seeAllIndividuals: a.seeAllIndividuals,
  seeAllEmployees: a.seeAllEmployees,
  canSeeTransactions: a.canSeeTransactions,
  canSeeMoney: a.canSeeMoney,
  canSeeHours: a.canSeeHours,
  canSeeBilledAmounts: a.canSeeBilledAmounts,
  canSeeEmployeeAmounts: a.canSeeEmployeeAmounts,
  canSeeAgencySpread: a.canSeeAgencySpread,
  canSeeCheckGross: a.canSeeCheckGross,
  canSeeCheckNet: a.canSeeCheckNet,
  canSeeTaxes: a.canSeeTaxes,
  canSeeBudgets: a.canSeeBudgets && a.canSeeHours,
  canSeeEmployeeDeals: a.canSeeEmployeeDeals,
  canSeeSettlements: a.canSeeSettlements,
  canManageSettlements: a.canSeeSettlements && a.canManageSettlements,
  canSeeClassFinancials: a.canSeeMoney && a.canSeeClassFinancials,
  canManageClassInvoices: a.canSeeMoney && a.canSeeClassFinancials && a.canManageClassInvoices,
  canViewDocuments: a.canViewDocuments || a.canEditDocuments,
  canEditDocuments: a.canEditDocuments,
  canPlan: a.canPlan || a.canManagePlanning,
  canManagePlanning: a.canManagePlanning,
  individualIds: [...a.individualIds],
  employeeIds: [...a.employeeIds],
});

type AccountProfileId = AccountPresetId;

interface AccountProfile {
  id: AccountProfileId;
  label: string;
  description: string;
  role: "viewer" | "manager" | "admin";
  access?: UserAccessConfig;
}

const ACCOUNT_PROFILES: AccountProfile[] = [
  ...ACCOUNT_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    role: preset.role,
    access: preset.access,
  })),
];

const ACCESS_PROFILE_KEYS = [
  "accessScope",
  "seeAllIndividuals",
  "seeAllEmployees",
  "canSeeTransactions",
  "canSeeMoney",
  "canSeeHours",
  "canSeeBilledAmounts",
  "canSeeEmployeeAmounts",
  "canSeeAgencySpread",
  "canSeeCheckGross",
  "canSeeCheckNet",
  "canSeeTaxes",
  "canSeeBudgets",
  "canSeeEmployeeDeals",
  "canSeeSettlements",
  "canManageSettlements",
  "canSeeClassFinancials",
  "canManageClassInvoices",
  "canViewDocuments",
  "canEditDocuments",
  "canPlan",
  "canManagePlanning",
] as const;

type AccessWithPeople = Pick<AccessState, (typeof ACCESS_PROFILE_KEYS)[number]> & (
  | Pick<AccessState, "individualIds" | "employeeIds">
  | { individualCount: number; employeeCount: number }
);

function matchesPreset(value: AccessWithPeople, preset: UserAccessConfig) {
  if (!ACCESS_PROFILE_KEYS.every((key) => value[key] === preset[key])) return false;
  const individualCount = "individualIds" in value ? value.individualIds.size : value.individualCount;
  const employeeCount = "employeeIds" in value ? value.employeeIds.size : value.employeeCount;
  return individualCount === preset.individualIds.length && employeeCount === preset.employeeIds.length;
}

function profileForAccess(role: string, access: AccessWithPeople): AccountProfileId {
  if (role === "admin") return "owner";
  if (role === "manager") return "office_manager";
  if (matchesPreset(access, BUDGET_PLANNER_ACCESS)) return "budget_planner";
  if (matchesPreset(access, STAFFING_MANAGER_ACCESS)) return "staffing_manager";
  if (matchesPreset(access, COLLECTIONS_ACCESS)) return "money_collector";
  if (matchesPreset(access, CLASS_BILLING_ACCESS)) return "class_billing";
  return "custom_access";
}

function accountProfile(id: AccountProfileId) {
  return ACCOUNT_PROFILES.find((profile) => profile.id === id) ?? ACCOUNT_PROFILES[0];
}

function isExternalPortalPreset(id: AccountPresetId | null): boolean {
  if (!id) return false;
  const kind = getAccountPreset(id)?.binding.kind;
  return kind === "individual" || kind === "employee" || kind === "agency";
}

function portalRoleForPreset(id: AccountPresetId, relationship: string): PortalRole | null {
  const binding = getAccountPreset(id)?.binding;
  if (!binding) return null;
  if (binding.kind === "individual") return relationship === "self" ? "individual" : "parent";
  if (binding.kind === "employee") return "employee";
  if (binding.kind === "agency") return binding.role;
  if (binding.kind === "owner") return "owner";
  return null;
}

function capabilityLabel(capability: PortalCapability): string {
  return capability
    .replaceAll(".", " · ")
    .replaceAll("_", " ")
    .replace(/\b(?:self|agency)\b/g, (word) => word === "self" ? "linked person" : "linked agency")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function PortalPermissionAdjustments({
  presetId,
  relationship,
  grants,
  denials,
  onChange,
}: {
  presetId: AccountPresetId;
  relationship: string;
  grants: Set<PortalCapability>;
  denials: Set<PortalCapability>;
  onChange: (grants: Set<PortalCapability>, denials: Set<PortalCapability>) => void;
}) {
  const preset = getAccountPreset(presetId);
  const role = portalRoleForPreset(presetId, relationship);
  if (!preset || !role || role === "owner") return null;

  const roleDefaults = new Set(portalCapabilitiesForRole(role));
  const presetDefaults = new Set<PortalCapability>(roleDefaults);
  if (preset.binding.kind === "individual") {
    for (const capability of preset.binding.defaultCapabilityGrants) presetDefaults.add(capability);
  }
  const available = PORTAL_CAPABILITIES.filter((capability) =>
    portalCapabilityAllowedForRole(role, capability));

  function setMode(capability: PortalCapability, mode: "default" | "grant" | "deny") {
    const nextGrants = new Set(grants);
    const nextDenials = new Set(denials);
    nextGrants.delete(capability);
    nextDenials.delete(capability);
    if (mode === "grant") nextGrants.add(capability);
    if (mode === "deny") nextDenials.add(capability);
    onChange(nextGrants, nextDenials);
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-ink-soft)]">
        Keep the preset default, explicitly show an optional item, or hide an item. Hiding always wins.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {available.map((capability) => {
          const mode = denials.has(capability) ? "deny" : grants.has(capability) ? "grant" : "default";
          return (
            <label key={capability} className="rounded border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-2.5 py-2 text-xs">
              <span className="block font-medium text-[var(--color-ink)]">{capabilityLabel(capability)}</span>
              <select
                value={mode}
                onChange={(event) => setMode(capability, event.target.value as "default" | "grant" | "deny")}
                className="input mt-1 w-full text-xs"
                aria-label={`${capabilityLabel(capability)} permission`}
              >
                <option value="default">Preset: {presetDefaults.has(capability) ? "shown" : "hidden"}</option>
                <option value="grant">Show</option>
                <option value="deny">Hide</option>
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function generateTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

type VisibilityKey =
  | "canSeeHours"
  | "canSeeBilledAmounts"
  | "canSeeEmployeeAmounts"
  | "canSeeAgencySpread"
  | "canSeeCheckGross"
  | "canSeeCheckNet"
  | "canSeeTaxes"
  | "canSeeBudgets"
  | "canSeeEmployeeDeals"
  | "canSeeSettlements"
  | "canSeeClassFinancials";

const VISIBILITY_OPTIONS: Array<{
  key: VisibilityKey;
  label: string;
  description: string;
  requiresMoney?: boolean;
}> = [
  { key: "canSeeHours", label: "Hours", description: "authorized, scheduled and billed time" },
  { key: "canSeeBilledAmounts", label: "Funder amounts", description: "rates and totals billed to the funder", requiresMoney: true },
  { key: "canSeeEmployeeAmounts", label: "Employee base", description: "base amounts earned or payable", requiresMoney: true },
  { key: "canSeeAgencySpread", label: "Agency spread", description: "the billed-to-base difference", requiresMoney: true },
  { key: "canSeeCheckGross", label: "Check gross", description: "gross pay recorded on employee checks", requiresMoney: true },
  { key: "canSeeCheckNet", label: "Check net", description: "net pay recorded on employee checks", requiresMoney: true },
  { key: "canSeeTaxes", label: "Taxes and withholding", description: "payroll withholding and deduction details", requiresMoney: true },
  { key: "canSeeBudgets", label: "Budgets", description: "individual budgets and annual plans; enabling this also enables Hours" },
  { key: "canSeeEmployeeDeals", label: "Employee deals", description: "deal terms and calculated obligations", requiresMoney: true },
  { key: "canSeeSettlements", label: "Collection reports", description: "balances, collections, credits, and set-aside reporting", requiresMoney: true },
  { key: "canSeeClassFinancials", label: "Class revenue", description: "annual class allowances, invoices, and reimbursement profiles", requiresMoney: true },
];

/* ------------------------------------------------------------ multi-select */

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  options: Option[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const base = n ? options.filter((o) => o.name.toLowerCase().includes(n)) : options;
    return base.slice(0, 300);
  }, [q, options]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className={disabled ? "pointer-events-none opacity-50" : ""}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--color-ink)]">{label}</span>
        <span className="text-xs text-[var(--color-ink-faint)]">{selected.size} selected</span>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search…"
        className="input mt-1 w-full text-sm"
        aria-label={`Search ${label}`}
      />
      <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-[var(--color-rule)]">
        {filtered.length === 0 ? (
          <p className="px-2 py-2 text-xs text-[var(--color-ink-faint)]">No matches.</p>
        ) : (
          filtered.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-[var(--color-surface-strong)]">
              <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} />
              <span className="truncate">{o.name}</span>
            </label>
          ))
        )}
      </div>
      {selected.size > 0 ? (
        <button type="button" onClick={() => onChange(new Set())} className="mt-1 text-xs text-[var(--color-primary)] hover:underline">
          Clear {selected.size}
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- access-config UI */

function AccessConfig({
  value,
  onChange,
  individuals,
  employees,
  role,
}: {
  value: AccessState;
  onChange: (next: AccessState) => void;
  individuals: Option[];
  employees: Option[];
  role: string;
}) {
  if (role !== "viewer") {
    return (
      <p className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-ink-soft)]">
        {role === "admin" ? "Administrators" : "Managers"} see everything. Custom access applies to the <span className="font-medium">restricted staff</span> role.
      </p>
    );
  }
  const limitedToPeople = !value.seeAllIndividuals || !value.seeAllEmployees;
  const set = (patch: Partial<AccessState>) => onChange({ ...value, ...patch });
  const applyMoneyOperatorAccess = () => onChange(accessFromPreset(COLLECTIONS_ACCESS));
  const applyBudgetPlannerAccess = () => onChange(accessFromPreset(BUDGET_PLANNER_ACCESS));
  const applyStaffingManagerAccess = () => onChange(accessFromPreset(STAFFING_MANAGER_ACCESS));
  const applyClassBillingAccess = () => onChange(accessFromPreset(CLASS_BILLING_ACCESS));
  const setVisibility = (key: VisibilityKey, checked: boolean) => {
    if (key === "canSeeHours" && !checked) {
      set({ canSeeHours: false, canSeeBudgets: false });
      return;
    }
    if (key === "canSeeBudgets" && checked) {
      set({ canSeeBudgets: true, canSeeHours: true });
      return;
    }
    if (key === "canSeeSettlements" && !checked) {
      set({ canSeeSettlements: false, canManageSettlements: false });
      return;
    }
    set({ [key]: checked } as Partial<AccessState>);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] pb-3">
        <div>
          <p className="text-sm font-medium text-[var(--color-ink)]">Access template</p>
          <p className="text-xs text-[var(--color-ink-faint)]">Choose an operational profile, then adjust any field below.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={applyBudgetPlannerAccess}
            className="btn btn-sm btn-secondary"
            title="Allow schedules and hour budgets without transactions or money"
          >
            <CalendarClock aria-hidden className="h-4 w-4" />
            Budget planner
          </button>
          <button
            type="button"
            onClick={applyMoneyOperatorAccess}
            className="btn btn-sm btn-secondary"
            title="Allow collections and set-asides without exposing budgets"
          >
            <WalletCards aria-hidden className="h-4 w-4" />
            Money collector
          </button>
          <button
            type="button"
            onClick={applyStaffingManagerAccess}
            className="btn btn-sm btn-secondary"
            title="Allow employees, assignments, and schedules without budgets or money"
          >
            <UsersRound aria-hidden className="h-4 w-4" />
            Staffing manager
          </button>
          <button
            type="button"
            onClick={applyClassBillingAccess}
            className="btn btn-sm btn-secondary"
            title="Allow class allowances, invoices, cover sheets, and PDF editing"
          >
            <GraduationCap aria-hidden className="h-4 w-4" />
            Class billing
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => set({ accessScope: "scoped", seeAllIndividuals: true, seeAllEmployees: true })}
          className={`btn btn-sm ${!limitedToPeople ? "btn-primary" : "btn-secondary"}`}
        >
          Everyone
        </button>
        <button
          type="button"
          onClick={() => set({ accessScope: "scoped", seeAllIndividuals: false, seeAllEmployees: false })}
          className={`btn btn-sm ${limitedToPeople ? "btn-primary" : "btn-secondary"}`}
        >
          Only certain people
        </button>
      </div>

      {limitedToPeople ? (
        <div className="space-y-3 rounded-lg border border-[var(--color-primary-soft)] p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <MultiSelect
                label="Individuals they can see"
                options={individuals}
                selected={value.individualIds}
                onChange={(s) => set({ individualIds: s })}
                disabled={value.seeAllIndividuals}
              />
              <label className="mt-1.5 flex items-center gap-2 text-xs text-[var(--color-ink-soft)]">
                <input type="checkbox" checked={value.seeAllIndividuals} onChange={(e) => set({ seeAllIndividuals: e.target.checked })} />
                See all individuals
              </label>
            </div>
            <div>
              <MultiSelect
                label="Employees they can see"
                options={employees}
                selected={value.employeeIds}
                onChange={(s) => set({ employeeIds: s })}
                disabled={value.seeAllEmployees}
              />
              <label className="mt-1.5 flex items-center gap-2 text-xs text-[var(--color-ink-soft)]">
                <input type="checkbox" checked={value.seeAllEmployees} onChange={(e) => set({ seeAllEmployees: e.target.checked })} />
                See all employees
              </label>
            </div>
          </div>
          <p className="text-xs text-[var(--color-ink-faint)]">
            They&rsquo;ll also see everyone <span className="font-medium">connected</span> to their choices — the individuals a chosen employee works with, and the employees a chosen individual works with. Turn on &ldquo;see all&rdquo; to widen either side to everyone.
          </p>
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.canSeeTransactions} onChange={(e) => set({ canSeeTransactions: e.target.checked })} />
        <span>Can see Transactions</span>
        <span className="text-xs text-[var(--color-ink-faint)]">— the billing ledger and every drill-through into it</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.canPlan}
          onChange={(event) => set(event.target.checked
            ? { canPlan: true }
            : { canPlan: false, canManagePlanning: false })}
        />
        <span>Can view Planning</span>
        <span className="text-xs text-[var(--color-ink-faint)]">calendar, assignments, availability, and hour-based coverage; requires all people</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.canManagePlanning}
          onChange={(event) => set(event.target.checked
            ? { canPlan: true, canManagePlanning: true }
            : { canManagePlanning: false })}
        />
        <span>Can manage Planning</span>
        <span className="text-xs text-[var(--color-ink-faint)]">create or change assignments, employee hours, time off, authorizations, sessions, and series</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.canViewDocuments}
          onChange={(event) => set(event.target.checked
            ? { canViewDocuments: true }
            : { canViewDocuments: false, canEditDocuments: false })}
        />
        <span>Can view documents</span>
        <span className="text-xs text-[var(--color-ink-faint)]">browse versions and download saved files</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.canEditDocuments}
          onChange={(event) => set(event.target.checked
            ? { canViewDocuments: true, canEditDocuments: true }
            : { canEditDocuments: false })}
        />
        <span>Can edit PDF documents</span>
        <span className="text-xs text-[var(--color-ink-faint)]">upload, archive, restore, and save source-preserving edits</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.canSeeMoney} onChange={(e) => set({ canSeeMoney: e.target.checked })} />
        <span className="font-medium">Allow dollar amounts</span>
        <span className="text-xs text-[var(--color-ink-faint)]">master switch for every money permission below</span>
      </label>
      <label className={`flex items-center gap-2 text-sm ${!value.canSeeMoney || !value.canSeeClassFinancials ? "opacity-50" : ""}`}>
        <input
          type="checkbox"
          checked={value.canManageClassInvoices}
          disabled={!value.canSeeMoney || !value.canSeeClassFinancials}
          onChange={(e) => set({ canManageClassInvoices: e.target.checked })}
        />
        <span>Can manage class invoices</span>
      </label>
      <label className={`flex items-center gap-2 text-sm ${!value.canSeeMoney || !value.canSeeSettlements ? "opacity-50" : ""}`}>
        <input
          type="checkbox"
          checked={value.canManageSettlements}
          disabled={!value.canSeeMoney || !value.canSeeSettlements}
          onChange={(event) => set({ canManageSettlements: event.target.checked })}
        />
        <span>Can record and reverse collections</span>
        <span className="text-xs text-[var(--color-ink-faint)]">write access to the money ledger</span>
      </label>

      <fieldset className="border-t border-[var(--color-rule)] pt-3">
        <legend className="eyebrow pr-2 text-[var(--color-ink-faint)]">Visible information</legend>
        <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
          {VISIBILITY_OPTIONS.map((option) => {
            const unavailable = option.requiresMoney === true && !value.canSeeMoney;
            return (
              <label key={option.key} className={`flex items-start gap-2 text-sm ${unavailable ? "opacity-50" : ""}`}>
                <input
                  type="checkbox"
                  checked={value[option.key]}
                  onChange={(e) => setVisibility(option.key, e.target.checked)}
                  disabled={unavailable}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-xs text-[var(--color-ink-faint)]">{option.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

/* ------------------------------------------------------------- main widget */

export default function UserAccessAdmin({
  currentUserId,
  initialUsers,
  individuals,
  employees,
  agencies,
}: {
  currentUserId: string;
  initialUsers: UserRow[];
  individuals: Option[];
  employees: Option[];
  agencies: Option[];
}) {
  const router = useRouter();
  const users = initialUsers;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const actionBusy = busy || refreshing;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!busy && !refreshing) setBusyAction(null);
  }, [busy, refreshing]);

  // Add-user form.
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ email: "", displayName: "" });
  const [addProfile, setAddProfile] = useState<AccountProfileId>("budget_planner");
  const [addAccess, setAddAccess] = useState<AccessState>(() => accessFromPreset(BUDGET_PLANNER_ACCESS));
  const [addIndividualId, setAddIndividualId] = useState("");
  const [addRelationship, setAddRelationship] = useState("parent");
  const [addEmployeeId, setAddEmployeeId] = useState("");
  const [addAgencyId, setAddAgencyId] = useState("");
  const [addCapabilityGrants, setAddCapabilityGrants] = useState<Set<PortalCapability>>(() => new Set());
  const [addCapabilityDenials, setAddCapabilityDenials] = useState<Set<PortalCapability>>(() => new Set());
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [createdCredential, setCreatedCredential] = useState<{ id: string; email: string; password: string; preset: AccountPresetId } | null>(null);
  const [copiedCredential, setCopiedCredential] = useState(false);

  // Per-user edit panel.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAccess, setEditAccess] = useState<AccessState | null>(null);
  const [editProfile, setEditProfile] = useState<AccountProfileId>("custom_access");
  const [newPassword, setNewPassword] = useState("");
  const [loadingEdit, setLoadingEdit] = useState(false);
  const accessLoadRequest = useRef(0);
  const customAccessSnapshot = useRef<AccessState | null>(null);
  // True when the current access couldn't be loaded — we then REFUSE to save,
  // rather than silently overwriting the user's real access with blank defaults.
  const [editLoadFailed, setEditLoadFailed] = useState(false);

  async function patch(
    id: string,
    body: Record<string, unknown>,
    okMsg = "Saved.",
    actionKey = `access:${id}`,
  ) {
    setError(null);
    setNotice(null);
    setBusyAction(actionKey);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) setError(data.error ?? "That change was rejected.");
      else {
        setNotice(okMsg);
        startRefresh(() => router.refresh());
      }
      return res.ok && data.ok === true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openEdit(u: UserRow) {
    if (editingId === u.id) {
      accessLoadRequest.current += 1;
      setEditingId(null);
      return;
    }
    setEditingId(u.id);
    if (u.portalManaged) {
      accessLoadRequest.current += 1;
      setNewPassword("");
      setEditAccess(null);
      setEditLoadFailed(false);
      setLoadingEdit(false);
      return;
    }
    loadAccess(u.id, u.role, u.accountPreset);
  }

  function toggleAdd() {
    if (addOpen) {
      setAddOpen(false);
      return;
    }
    setError(null);
    setNotice(null);
    setCreatedCredential(null);
    setCopiedCredential(false);
    setForm({ email: "", displayName: "" });
    setAddProfile("budget_planner");
    setAddAccess(accessFromPreset(BUDGET_PLANNER_ACCESS));
    setAddIndividualId("");
    setAddRelationship("parent");
    setAddEmployeeId("");
    setAddAgencyId("");
    setAddCapabilityGrants(new Set());
    setAddCapabilityDenials(new Set());
    setTemporaryPassword(generateTemporaryPassword());
    setAddOpen(true);
  }

  function chooseAddProfile(id: AccountProfileId) {
    setAddProfile(id);
    setAddIndividualId("");
    setAddEmployeeId("");
    setAddAgencyId("");
    setAddCapabilityGrants(new Set());
    setAddCapabilityDenials(new Set());
    const profile = accountProfile(id);
    if (profile.access) setAddAccess(accessFromPreset(profile.access));
    else if (id === "custom_access") setAddAccess(emptyAccess());
  }

  function chooseEditProfile(id: AccountProfileId) {
    if (editProfile === "custom_access" && editAccess) {
      customAccessSnapshot.current = cloneAccess(editAccess);
    }
    setEditProfile(id);
    const profile = accountProfile(id);
    if (profile.access) {
      setEditAccess(accessFromPreset(profile.access));
    } else if (id === "custom_access") {
      setEditAccess(customAccessSnapshot.current ? cloneAccess(customAccessSnapshot.current) : emptyAccess());
    }
  }

  async function loadAccess(userId: string, role: string, storedPreset?: AccountPresetId | null) {
    const requestId = ++accessLoadRequest.current;
    setNewPassword("");
    setEditAccess(null);
    customAccessSnapshot.current = null;
    setEditLoadFailed(false);
    setLoadingEdit(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`);
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        access?: {
          accessScope: "full" | "scoped";
          seeAllIndividuals: boolean;
          seeAllEmployees: boolean;
          canSeeTransactions: boolean;
          canSeeMoney: boolean;
          canSeeHours: boolean;
          canSeeBilledAmounts: boolean;
          canSeeEmployeeAmounts: boolean;
          canSeeAgencySpread: boolean;
          canSeeCheckGross?: boolean;
          canSeeCheckNet: boolean;
          canSeeTaxes: boolean;
          canSeeBudgets: boolean;
          canSeeEmployeeDeals: boolean;
          canSeeSettlements: boolean;
          canManageSettlements: boolean;
          canSeeClassFinancials: boolean;
          canManageClassInvoices: boolean;
          canViewDocuments?: boolean;
          canEditDocuments: boolean;
          canPlan: boolean;
          canManagePlanning?: boolean;
          individualIds: string[];
          employeeIds: string[];
        };
      };
      if (requestId !== accessLoadRequest.current) return;
      if (data.ok && data.access) {
        const legacyFullViewer = role === "viewer" && data.access.accessScope === "full";
        const loadedAccess: AccessState = {
          accessScope: legacyFullViewer ? "scoped" : data.access.accessScope,
          seeAllIndividuals: legacyFullViewer || data.access.seeAllIndividuals,
          seeAllEmployees: legacyFullViewer || data.access.seeAllEmployees,
          canSeeTransactions: data.access.canSeeTransactions,
          canSeeMoney: data.access.canSeeMoney !== false,
          canSeeHours: data.access.canSeeHours !== false,
          canSeeBilledAmounts: data.access.canSeeBilledAmounts !== false,
          canSeeEmployeeAmounts: data.access.canSeeEmployeeAmounts !== false,
          canSeeAgencySpread: data.access.canSeeAgencySpread !== false,
          canSeeCheckGross: data.access.canSeeCheckGross ?? (data.access.canSeeCheckNet !== false),
          canSeeCheckNet: data.access.canSeeCheckNet !== false,
          canSeeTaxes: data.access.canSeeTaxes !== false,
          canSeeBudgets: data.access.canSeeBudgets !== false && data.access.canSeeHours !== false,
          canSeeEmployeeDeals: data.access.canSeeEmployeeDeals === true,
          canSeeSettlements: data.access.canSeeSettlements === true,
          canManageSettlements: data.access.canManageSettlements === true,
          canSeeClassFinancials: data.access.canSeeClassFinancials === true,
          canManageClassInvoices: data.access.canManageClassInvoices === true,
          canViewDocuments: data.access.canViewDocuments ?? (data.access.canEditDocuments === true),
          canEditDocuments: data.access.canEditDocuments === true,
          canPlan: data.access.canPlan === true || data.access.canManagePlanning === true,
          canManagePlanning: data.access.canManagePlanning ?? (data.access.canPlan === true),
          individualIds: new Set(data.access.individualIds),
          employeeIds: new Set(data.access.employeeIds),
        };
        const selectedPreset = storedPreset ? getAccountPreset(storedPreset) : null;
        let loadedProfile = profileForAccess(role, loadedAccess);
        if (storedPreset && selectedPreset?.role === role && !isExternalPortalPreset(storedPreset)) {
          loadedProfile = storedPreset;
        }
        setEditAccess(loadedAccess);
        setEditProfile(loadedProfile);
        if (loadedProfile === "custom_access") customAccessSnapshot.current = cloneAccess(loadedAccess);
      } else {
        // Loading failed — do NOT default to full access; block saving instead.
        setEditAccess(null);
        setEditLoadFailed(true);
      }
    } catch {
      if (requestId !== accessLoadRequest.current) return;
      setEditAccess(null);
      setEditLoadFailed(true);
    } finally {
      if (requestId === accessLoadRequest.current) setLoadingEdit(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editAccess) {
      setError("Couldn't load this person's current access. Close and reopen before saving so nothing is reset by accident.");
      return;
    }
    if (newPassword.trim().length > 0 && newPassword.trim().length < 10) {
      setError("Enter a temporary password of at least 10 characters.");
      return;
    }
    const profile = accountProfile(editProfile);
    const body: Record<string, unknown> = { role: profile.role, preset: editProfile };
    if (profile.role === "viewer") {
      Object.assign(body, accessToBody(editAccess));
    }
    if (newPassword.trim().length > 0) body.password = newPassword.trim();
    const ok = await patch(id, body, "Access updated.");
    if (ok) {
      setEditingId(null);
      setNewPassword("");
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusyAction("create");
    setBusy(true);
    try {
      const password = temporaryPassword || generateTemporaryPassword();
      const preset = getAccountPreset(addProfile)!;
      const body: Record<string, unknown> = { ...form, password, preset: addProfile };
      if (preset.binding.kind === "individual") {
        Object.assign(body, { individualId: addIndividualId, relationship: addRelationship });
      } else if (preset.binding.kind === "employee") {
        Object.assign(body, { employeeId: addEmployeeId });
      } else if (preset.binding.kind === "agency") {
        Object.assign(body, { agencyId: addAgencyId });
      }
      if (preset.role === "viewer" && preset.binding.kind === "none") {
        Object.assign(body, { internalAccess: accessToBody(addAccess) });
      }
      if (isExternalPortalPreset(addProfile)) {
        if (addCapabilityGrants.size > 0) body.capabilityGrants = [...addCapabilityGrants];
        if (addCapabilityDenials.size > 0) body.capabilityDenials = [...addCapabilityDenials];
      }
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: { id: string };
      };
      if (!res.ok || !data.ok) setError(data.error ?? "The account could not be created.");
      else if (!data.user?.id) setError("The login was created, but it could not be opened for preview yet. Refresh and use Sign in as.");
      else {
        setCreatedCredential({ id: data.user.id, email: form.email.trim(), password, preset: addProfile });
        setCopiedCredential(false);
        setForm({ email: "", displayName: "" });
        setAddOpen(false);
        startRefresh(() => router.refresh());
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function savePortalPassword(id: string) {
    if (newPassword.trim().length < 10) {
      setError("Enter a temporary password of at least 10 characters.");
      return;
    }
    const ok = await patch(id, { password: newPassword.trim() }, "Password updated.", `password:${id}`);
    if (ok) {
      setEditingId(null);
      setNewPassword("");
    }
  }

  async function copyCreatedPassword() {
    if (!createdCredential) return;
    try {
      await navigator.clipboard.writeText(createdCredential.password);
      setCopiedCredential(true);
    } catch {
      setError("Could not copy automatically. Select the temporary password and copy it manually.");
    }
  }

  const addPreset = getAccountPreset(addProfile)!;
  const addBinding = addPreset.binding.kind;
  const addPreview = ROLE_PREVIEW_DETAILS[addProfile];

  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]">
      <header className="flex items-center justify-between border-b border-[var(--color-rule)] px-5 py-3">
        <div>
          <h2 className="display text-base font-medium">Team access</h2>
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
            Create a login by choosing what the person does.
          </p>
        </div>
        <button type="button" onClick={toggleAdd} aria-expanded={addOpen} className="btn btn-sm btn-primary">
          {addOpen ? <X aria-hidden className="h-4 w-4" /> : <Plus aria-hidden className="h-4 w-4" />}
          {addOpen ? "Close" : "Add person"}
        </button>
      </header>

      {error ? (
        <p role="alert" className="mx-5 mt-3 rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mx-5 mt-3 rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">{notice}</p>
      ) : null}

      {createdCredential ? (
        <div role="status" className="mx-5 mt-3 border-l-4 border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="font-semibold text-[var(--color-ink)]">Login created for {createdCredential.email}</p>
            <button
              type="button"
              onClick={() => setCreatedCredential(null)}
              className="icon-button shrink-0"
              aria-label="Dismiss temporary password"
              title="Dismiss"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="select-all rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)]">
              {createdCredential.password}
            </code>
            <button type="button" onClick={copyCreatedPassword} className="btn btn-sm btn-secondary">
              {copiedCredential ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
              {copiedCredential ? "Copied" : "Copy password"}
            </button>
            <form method="post" action="/api/auth/impersonation/start" onSubmit={() => setImpersonatingId(createdCredential.id)}>
              <input type="hidden" name="targetUserId" value={createdCredential.id} />
              <button type="submit" className="btn btn-sm btn-primary" disabled={impersonatingId !== null}>
                <LogIn aria-hidden className="h-4 w-4" />
                {isExternalPortalPreset(createdCredential.preset) ? "Preview this portal" : "Preview / Sign in as"}
              </button>
            </form>
          </div>
          <p className="mt-2 text-xs text-[var(--color-ink-soft)]">This temporary password is shown once. Send it to the person privately.</p>
        </div>
      ) : null}

      {addOpen ? (
        <form onSubmit={onCreate} className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-5 py-4">
          <h3 className="text-sm font-semibold">New login</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-xs font-medium">Name</span>
              <input required autoComplete="name" type="text" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="input mt-1 w-full text-sm" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium">Email</span>
              <input required autoComplete="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input mt-1 w-full text-sm" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium">What will they do?</span>
              <select value={addProfile} onChange={(e) => chooseAddProfile(e.target.value as AccountProfileId)} className="input mt-1 w-full text-sm">
                <optgroup label="Agency team">
                  {ACCOUNT_PROFILES.filter((profile) => [
                    "owner", "office_manager", "budget_planner", "staffing_manager", "money_collector", "class_billing",
                  ].includes(profile.id)).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </optgroup>
                <optgroup label="Portals">
                  {ACCOUNT_PROFILES.filter((profile) => [
                    "individual_parent", "employee", "agency", "agency_scheduler",
                    "agency_staffing_manager", "agency_collector",
                  ].includes(profile.id)).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </optgroup>
                <optgroup label="Advanced">
                  {ACCOUNT_PROFILES.filter((profile) => profile.id === "custom_access")
                    .map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </optgroup>
              </select>
            </label>
          </div>
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{accountProfile(addProfile).description}</p>
          {addBinding === "individual" ? (
            <div className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-xs font-medium">Individual</span>
                <select required value={addIndividualId} onChange={(event) => setAddIndividualId(event.target.value)} className="input mt-1 w-full text-sm">
                  <option value="">Choose an individual</option>
                  {individuals.map((individual) => <option key={individual.id} value={individual.id}>{individual.name}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-xs font-medium">Relationship</span>
                <select required value={addRelationship} onChange={(event) => setAddRelationship(event.target.value)} className="input mt-1 w-full text-sm">
                  <option value="parent">Parent</option>
                  <option value="guardian">Guardian</option>
                  <option value="representative">Representative</option>
                  <option value="self">The individual</option>
                </select>
              </label>
            </div>
          ) : null}
          {addBinding === "employee" ? (
            <label className="mt-3 block max-w-md text-sm">
              <span className="text-xs font-medium">Employee</span>
              <select required value={addEmployeeId} onChange={(event) => setAddEmployeeId(event.target.value)} className="input mt-1 w-full text-sm">
                <option value="">Choose an employee</option>
                {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
              </select>
            </label>
          ) : null}
          {addBinding === "agency" ? (
            <label className="mt-3 block max-w-md text-sm">
              <span className="text-xs font-medium">Agency</span>
              <select required value={addAgencyId} onChange={(event) => setAddAgencyId(event.target.value)} className="input mt-1 w-full text-sm">
                <option value="">Choose an agency</option>
                {agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
              </select>
            </label>
          ) : null}
          <section className="mt-4 grid gap-3 rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-3 sm:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">Main home</p>
              <p className="mt-1 text-sm font-medium">{addPreview.landingLabel}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">Visible</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">{addPreview.visible}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">Hidden</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">{addPreview.hidden}</p>
            </div>
          </section>
          <details className="mt-3 rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Adjust permissions</summary>
            <div className="mt-3">
              {addPreset.role === "viewer" && addBinding === "none" ? (
                <AccessConfig value={addAccess} onChange={setAddAccess} individuals={individuals} employees={employees} role="viewer" />
              ) : isExternalPortalPreset(addProfile) ? (
                <PortalPermissionAdjustments
                  presetId={addProfile}
                  relationship={addRelationship}
                  grants={addCapabilityGrants}
                  denials={addCapabilityDenials}
                  onChange={(grants, denials) => {
                    setAddCapabilityGrants(grants);
                    setAddCapabilityDenials(denials);
                  }}
                />
              ) : (
                <p className="text-xs text-[var(--color-ink-soft)]">
                  This trusted role has a fixed security boundary. Choose Custom access for a narrower account.
                </p>
              )}
            </div>
          </details>
          <button type="submit" disabled={actionBusy} aria-busy={actionBusy && busyAction === "create"} className="btn btn-primary mt-4">
            {actionBusy && busyAction === "create" ? "Creating…" : "Create login"}
          </button>
        </form>
      ) : null}

      <div className="divide-y divide-[var(--color-rule)]">
        {users.map((u) => {
          const self = u.id === currentUserId;
          const open = editingId === u.id;
          const portalAccount = u.portalManaged;
          const currentProfile = accountProfile(u.accountPreset ?? profileForAccess(u.role, u));
          const profileLabel = portalAccount && !u.accountPreset ? "Portal account" : currentProfile.label;
          return (
            <div key={u.id}>
              <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[var(--color-ink)]">
                    {u.displayName}
                    {!u.isActive ? <span className="ml-2 rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-[0.7rem] text-[var(--color-ink-faint)]">disabled</span> : null}
                  </p>
                  <p className="text-xs text-[var(--color-ink-faint)]">{u.email} · {profileLabel}</p>
                </div>
                <p className="hidden text-xs text-[var(--color-ink-faint)] sm:block">
                  {u.lastLoginAt ? `Last in ${new Date(u.lastLoginAt).toLocaleDateString()}` : "Never signed in"}
                </p>
                {self ? (
                  <span className="text-xs text-[var(--color-ink-faint)]">This is you</span>
                ) : (
                  <div className="flex flex-wrap justify-end gap-2">
                    {u.isActive ? (
                      <form method="post" action="/api/auth/impersonation/start" onSubmit={() => setImpersonatingId(u.id)}>
                        <input type="hidden" name="targetUserId" value={u.id} />
                        <button
                          type="submit"
                          disabled={impersonatingId !== null}
                          aria-busy={impersonatingId === u.id}
                          className="btn btn-sm btn-ghost"
                          title={`Sign in as ${u.displayName}`}
                        >
                          <LogIn aria-hidden className="h-4 w-4" />
                          {impersonatingId === u.id ? "Opening..." : "Sign in as"}
                        </button>
                      </form>
                    ) : null}
                    <button
                      type="button"
                      disabled={actionBusy}
                      aria-busy={actionBusy && busyAction === `toggle:${u.id}`}
                      onClick={() => patch(u.id, { isActive: !u.isActive }, "Saved.", `toggle:${u.id}`)}
                      className="btn btn-sm btn-ghost"
                    >
                      {actionBusy && busyAction === `toggle:${u.id}` ? (u.isActive ? "Disabling…" : "Enabling…") : u.isActive ? "Disable" : "Enable"}
                    </button>
                    <button type="button" onClick={() => openEdit(u)} className="btn btn-sm btn-secondary">
                      {open ? "Close" : "Manage"}
                    </button>
                  </div>
                )}
              </div>

              {open && !self ? (
                <div className="border-t border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-5 py-4">
                  {portalAccount ? (
                    <div className="space-y-4">
                      <div className="max-w-xl">
                        <p className="text-sm font-semibold">{profileLabel}</p>
                        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                          The person and agency connections are managed in Portal administration so changing a password cannot accidentally change who this account may see.
                        </p>
                        <Link href="/settings/agencies" className="btn btn-sm btn-secondary mt-3">Manage portal connections</Link>
                      </div>
                      <div className="max-w-lg rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-3">
                        <div className="flex items-end gap-2">
                          <div className="min-w-0 flex-1">
                            <PasswordField
                              label="New temporary password"
                              value={newPassword}
                              onChange={setNewPassword}
                              placeholder="At least 10 characters"
                              minLength={10}
                            />
                          </div>
                          <button type="button" onClick={() => setNewPassword(generateTemporaryPassword())} className="btn btn-sm btn-secondary">Generate</button>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button type="button" disabled={actionBusy} aria-busy={actionBusy && busyAction === `password:${u.id}`} onClick={() => void savePortalPassword(u.id)} className="btn btn-primary btn-sm">
                            {actionBusy && busyAction === `password:${u.id}` ? "Saving…" : "Save password"}
                          </button>
                          <button type="button" onClick={() => setEditingId(null)} className="btn btn-ghost btn-sm">Cancel</button>
                        </div>
                      </div>
                    </div>
                  ) : loadingEdit ? (
                    <p className="text-sm text-[var(--color-ink-faint)]">Loading…</p>
                  ) : editLoadFailed || !editAccess ? (
                    <div className="text-sm">
                      <p className="text-[var(--color-danger)]">Couldn&rsquo;t load this person&rsquo;s current access.</p>
                      <button type="button" onClick={() => loadAccess(u.id, u.role, u.accountPreset)} className="btn btn-sm btn-secondary mt-2">Try again</button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="max-w-lg">
                        <label className="block text-sm">
                          <span className="text-xs font-medium">What does this person do?</span>
                          <select value={editProfile} onChange={(e) => chooseEditProfile(e.target.value as AccountProfileId)} className="input mt-1 w-full text-sm">
                            {ACCOUNT_PROFILES
                              .filter((profile) => !isExternalPortalPreset(profile.id))
                              .map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                          </select>
                        </label>
                        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{accountProfile(editProfile).description}</p>
                      </div>

                      {accountProfile(editProfile).role === "viewer" ? (
                        <details className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
                          <summary className="cursor-pointer text-sm font-medium">Adjust permissions</summary>
                          <div className="mt-3">
                            <AccessConfig value={editAccess} onChange={setEditAccess} individuals={individuals} employees={employees} role="viewer" />
                          </div>
                        </details>
                      ) : null}

                      <details className="max-w-lg rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
                        <summary className="cursor-pointer text-sm font-medium">Reset password</summary>
                        <div className="mt-3 flex items-end gap-2">
                          <div className="min-w-0 flex-1">
                            <PasswordField
                              label="New temporary password"
                              value={newPassword}
                              onChange={setNewPassword}
                              placeholder="At least 10 characters"
                              minLength={10}
                            />
                          </div>
                          <button type="button" onClick={() => setNewPassword(generateTemporaryPassword())} className="btn btn-sm btn-secondary">Generate</button>
                        </div>
                      </details>
                      <div className="flex gap-2">
                        <button type="button" disabled={actionBusy} aria-busy={actionBusy && busyAction === `access:${u.id}`} onClick={() => saveEdit(u.id)} className="btn btn-primary btn-sm">
                          {actionBusy && busyAction === `access:${u.id}` ? "Saving…" : "Save changes"}
                        </button>
                        <button type="button" onClick={() => setEditingId(null)} className="btn btn-ghost btn-sm">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

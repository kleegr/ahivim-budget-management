"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Copy, Eye, EyeOff, GraduationCap, Plus, WalletCards, X } from "lucide-react";
import {
  BUDGET_PLANNER_ACCESS,
  CLASS_BILLING_ACCESS,
  COLLECTIONS_ACCESS,
} from "@/lib/auth/access-presets";
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
  canSeeCheckNet: boolean;
  canSeeTaxes: boolean;
  canSeeBudgets: boolean;
  canSeeEmployeeDeals: boolean;
  canSeeSettlements: boolean;
  canManageSettlements: boolean;
  canSeeClassFinancials: boolean;
  canManageClassInvoices: boolean;
  canEditDocuments: boolean;
  canPlan: boolean;
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
  canSeeCheckNet: boolean;
  canSeeTaxes: boolean;
  canSeeBudgets: boolean;
  canSeeEmployeeDeals: boolean;
  canSeeSettlements: boolean;
  canManageSettlements: boolean;
  canSeeClassFinancials: boolean;
  canManageClassInvoices: boolean;
  canEditDocuments: boolean;
  canPlan: boolean;
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
  canSeeCheckNet: false,
  canSeeTaxes: false,
  canSeeBudgets: false,
  canSeeEmployeeDeals: false,
  canSeeSettlements: false,
  canManageSettlements: false,
  canSeeClassFinancials: false,
  canManageClassInvoices: false,
  canEditDocuments: false,
  canPlan: false,
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
  canSeeCheckNet: a.canSeeCheckNet,
  canSeeTaxes: a.canSeeTaxes,
  canSeeBudgets: a.canSeeBudgets && a.canSeeHours,
  canSeeEmployeeDeals: a.canSeeEmployeeDeals,
  canSeeSettlements: a.canSeeSettlements,
  canManageSettlements: a.canSeeSettlements && a.canManageSettlements,
  canSeeClassFinancials: a.canSeeMoney && a.canSeeClassFinancials,
  canManageClassInvoices: a.canSeeMoney && a.canSeeClassFinancials && a.canManageClassInvoices,
  canEditDocuments: a.canEditDocuments,
  canPlan: a.canPlan,
  individualIds: [...a.individualIds],
  employeeIds: [...a.employeeIds],
});

type AccountProfileId =
  | "budget_planner"
  | "collections"
  | "manager"
  | "class_billing"
  | "admin"
  | "custom";

interface AccountProfile {
  id: AccountProfileId;
  label: string;
  description: string;
  role: "viewer" | "manager" | "admin";
  access?: UserAccessConfig;
}

const ACCOUNT_PROFILES: AccountProfile[] = [
  {
    id: "budget_planner",
    label: "Budget planner",
    description: "Calendar, assignments, and hour budgets. No dollar amounts or payroll transactions.",
    role: "viewer",
    access: BUDGET_PLANNER_ACCESS,
  },
  {
    id: "collections",
    label: "Collections",
    description: "Employee financials, collections, and set-asides. No budget planning.",
    role: "viewer",
    access: COLLECTIONS_ACCESS,
  },
  {
    id: "manager",
    label: "Office manager",
    description: "All everyday work, reports, budgets, and financials. Cannot manage user accounts.",
    role: "manager",
  },
  {
    id: "class_billing",
    label: "Class billing",
    description: "Class allowances, invoices, cover sheets, and documents.",
    role: "viewer",
    access: CLASS_BILLING_ACCESS,
  },
  {
    id: "admin",
    label: "Administrator",
    description: "Everything, including user accounts and system settings.",
    role: "admin",
  },
  {
    id: "custom",
    label: "Custom access",
    description: "Starts with no access. Open Advanced permissions only for an unusual combination.",
    role: "viewer",
  },
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
  "canSeeCheckNet",
  "canSeeTaxes",
  "canSeeBudgets",
  "canSeeEmployeeDeals",
  "canSeeSettlements",
  "canManageSettlements",
  "canSeeClassFinancials",
  "canManageClassInvoices",
  "canEditDocuments",
  "canPlan",
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
  if (role === "admin") return "admin";
  if (role === "manager") return "manager";
  if (matchesPreset(access, BUDGET_PLANNER_ACCESS)) return "budget_planner";
  if (matchesPreset(access, COLLECTIONS_ACCESS)) return "collections";
  if (matchesPreset(access, CLASS_BILLING_ACCESS)) return "class_billing";
  return "custom";
}

function accountProfile(id: AccountProfileId) {
  return ACCOUNT_PROFILES.find((profile) => profile.id === id) ?? ACCOUNT_PROFILES[0];
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
  { key: "canSeeCheckNet", label: "Check net", description: "net pay recorded on employee checks", requiresMoney: true },
  { key: "canSeeTaxes", label: "Taxes and withholding", description: "gross, net and payroll withholding details", requiresMoney: true },
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
            Money operator
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
        <input type="checkbox" checked={value.canPlan} onChange={(e) => set({ canPlan: e.target.checked })} />
        <span>Can manage Planning</span>
        <span className="text-xs text-[var(--color-ink-faint)]">recurring schedules and hour-based coverage; requires all people</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.canEditDocuments} onChange={(e) => set({ canEditDocuments: e.target.checked })} />
        <span>Can edit PDF documents</span>
        <span className="text-xs text-[var(--color-ink-faint)]">source-preserving cover sheets and form edits</span>
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
}: {
  currentUserId: string;
  initialUsers: UserRow[];
  individuals: Option[];
  employees: Option[];
}) {
  const router = useRouter();
  const users = initialUsers;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-user form.
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ email: "", displayName: "" });
  const [addProfile, setAddProfile] = useState<AccountProfileId>("budget_planner");
  const [addAccess, setAddAccess] = useState<AccessState>(() => accessFromPreset(BUDGET_PLANNER_ACCESS));
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [createdCredential, setCreatedCredential] = useState<{ email: string; password: string } | null>(null);
  const [copiedCredential, setCopiedCredential] = useState(false);

  // Per-user edit panel.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAccess, setEditAccess] = useState<AccessState | null>(null);
  const [editProfile, setEditProfile] = useState<AccountProfileId>("custom");
  const [newPassword, setNewPassword] = useState("");
  const [loadingEdit, setLoadingEdit] = useState(false);
  const accessLoadRequest = useRef(0);
  const customAccessSnapshot = useRef<AccessState | null>(null);
  // True when the current access couldn't be loaded — we then REFUSE to save,
  // rather than silently overwriting the user's real access with blank defaults.
  const [editLoadFailed, setEditLoadFailed] = useState(false);

  async function patch(id: string, body: Record<string, unknown>, okMsg = "Saved.") {
    setError(null);
    setNotice(null);
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
        router.refresh();
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
    loadAccess(u.id, u.role);
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
    setTemporaryPassword(generateTemporaryPassword());
    setAddOpen(true);
  }

  function chooseAddProfile(id: AccountProfileId) {
    setAddProfile(id);
    const profile = accountProfile(id);
    if (profile.access) setAddAccess(accessFromPreset(profile.access));
    else if (id === "custom") setAddAccess(emptyAccess());
  }

  function chooseEditProfile(id: AccountProfileId) {
    if (editProfile === "custom" && editAccess) {
      customAccessSnapshot.current = cloneAccess(editAccess);
    }
    setEditProfile(id);
    const profile = accountProfile(id);
    if (profile.access) {
      setEditAccess(accessFromPreset(profile.access));
    } else if (id === "custom") {
      setEditAccess(customAccessSnapshot.current ? cloneAccess(customAccessSnapshot.current) : emptyAccess());
    }
  }

  async function loadAccess(userId: string, role: string) {
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
          canSeeCheckNet: boolean;
          canSeeTaxes: boolean;
          canSeeBudgets: boolean;
          canSeeEmployeeDeals: boolean;
          canSeeSettlements: boolean;
          canManageSettlements: boolean;
          canSeeClassFinancials: boolean;
          canManageClassInvoices: boolean;
          canEditDocuments: boolean;
          canPlan: boolean;
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
          canSeeCheckNet: data.access.canSeeCheckNet !== false,
          canSeeTaxes: data.access.canSeeTaxes !== false,
          canSeeBudgets: data.access.canSeeBudgets !== false && data.access.canSeeHours !== false,
          canSeeEmployeeDeals: data.access.canSeeEmployeeDeals === true,
          canSeeSettlements: data.access.canSeeSettlements === true,
          canManageSettlements: data.access.canManageSettlements === true,
          canSeeClassFinancials: data.access.canSeeClassFinancials === true,
          canManageClassInvoices: data.access.canManageClassInvoices === true,
          canEditDocuments: data.access.canEditDocuments === true,
          canPlan: data.access.canPlan === true,
          individualIds: new Set(data.access.individualIds),
          employeeIds: new Set(data.access.employeeIds),
        };
        const loadedProfile = profileForAccess(role, loadedAccess);
        setEditAccess(loadedAccess);
        setEditProfile(loadedProfile);
        if (loadedProfile === "custom") customAccessSnapshot.current = cloneAccess(loadedAccess);
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
    const profile = accountProfile(editProfile);
    const body: Record<string, unknown> = { role: profile.role };
    if (profile.role === "viewer") {
      Object.assign(body, accessToBody(profile.access ? accessFromPreset(profile.access) : editAccess));
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
    setBusy(true);
    try {
      const profile = accountProfile(addProfile);
      const password = temporaryPassword || generateTemporaryPassword();
      const body: Record<string, unknown> = {
        ...form,
        password,
        role: profile.role,
      };
      if (profile.role === "viewer") {
        Object.assign(body, accessToBody(profile.access ? accessFromPreset(profile.access) : addAccess));
      }
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) setError(data.error ?? "The account could not be created.");
      else {
        setCreatedCredential({ email: form.email.trim(), password });
        setCopiedCredential(false);
        setForm({ email: "", displayName: "" });
        setAddOpen(false);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
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
                {ACCOUNT_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
              </select>
            </label>
          </div>
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{accountProfile(addProfile).description}</p>
          {addProfile === "custom" ? (
            <details className="mt-4 rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Advanced permissions</summary>
              <div className="mt-3">
                <AccessConfig value={addAccess} onChange={setAddAccess} individuals={individuals} employees={employees} role="viewer" />
              </div>
            </details>
          ) : null}
          <button type="submit" disabled={busy} className="btn btn-primary mt-4">{busy ? "Creating…" : "Create login"}</button>
        </form>
      ) : null}

      <div className="divide-y divide-[var(--color-rule)]">
        {users.map((u) => {
          const self = u.id === currentUserId;
          const open = editingId === u.id;
          const currentProfile = accountProfile(profileForAccess(u.role, u));
          return (
            <div key={u.id}>
              <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[var(--color-ink)]">
                    {u.displayName}
                    {!u.isActive ? <span className="ml-2 rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-[0.7rem] text-[var(--color-ink-faint)]">disabled</span> : null}
                  </p>
                  <p className="text-xs text-[var(--color-ink-faint)]">{u.email} · {currentProfile.label}</p>
                </div>
                <p className="hidden text-xs text-[var(--color-ink-faint)] sm:block">
                  {u.lastLoginAt ? `Last in ${new Date(u.lastLoginAt).toLocaleDateString()}` : "Never signed in"}
                </p>
                {self ? (
                  <span className="text-xs text-[var(--color-ink-faint)]">This is you</span>
                ) : (
                  <div className="flex gap-2">
                    <button type="button" disabled={busy} onClick={() => patch(u.id, { isActive: !u.isActive })} className="btn btn-sm btn-ghost">
                      {u.isActive ? "Disable" : "Enable"}
                    </button>
                    <button type="button" onClick={() => openEdit(u)} className="btn btn-sm btn-secondary">
                      {open ? "Close" : "Manage"}
                    </button>
                  </div>
                )}
              </div>

              {open && !self ? (
                <div className="border-t border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-5 py-4">
                  {loadingEdit ? (
                    <p className="text-sm text-[var(--color-ink-faint)]">Loading…</p>
                  ) : editLoadFailed || !editAccess ? (
                    <div className="text-sm">
                      <p className="text-[var(--color-danger)]">Couldn&rsquo;t load this person&rsquo;s current access.</p>
                      <button type="button" onClick={() => loadAccess(u.id, u.role)} className="btn btn-sm btn-secondary mt-2">Try again</button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="max-w-lg">
                        <label className="block text-sm">
                          <span className="text-xs font-medium">What does this person do?</span>
                          <select value={editProfile} onChange={(e) => chooseEditProfile(e.target.value as AccountProfileId)} className="input mt-1 w-full text-sm">
                            {ACCOUNT_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                          </select>
                        </label>
                        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{accountProfile(editProfile).description}</p>
                      </div>

                      {editProfile === "custom" ? (
                        <details className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
                          <summary className="cursor-pointer text-sm font-medium">Advanced permissions</summary>
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
                        <button type="button" disabled={busy} onClick={() => saveEdit(u.id)} className="btn btn-primary btn-sm">Save changes</button>
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

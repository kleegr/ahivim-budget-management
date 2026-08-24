"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Administrator user + access management.
 *
 * Beyond creating accounts and setting roles, this is where an admin hands out
 * SCOPED logins: a viewer who sees only certain individuals and/or employees
 * (plus everyone connected to them), with an optional lock on Transactions. Every
 * choice here is re-enforced on the server — the UI just makes it easy to set.
 */

type Option = { id: string; name: string };

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
  individualIds: new Set(),
  employeeIds: new Set(),
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
  individualIds: [...a.individualIds],
  employeeIds: [...a.employeeIds],
});

type VisibilityKey =
  | "canSeeHours"
  | "canSeeBilledAmounts"
  | "canSeeEmployeeAmounts"
  | "canSeeAgencySpread"
  | "canSeeCheckNet"
  | "canSeeTaxes"
  | "canSeeBudgets"
  | "canSeeEmployeeDeals"
  | "canSeeSettlements";

const VISIBILITY_OPTIONS: Array<{
  key: VisibilityKey;
  label: string;
  description: string;
  requiresMoney?: boolean;
}> = [
  { key: "canSeeHours", label: "Hours", description: "authorized, scheduled and billed time" },
  { key: "canSeeBilledAmounts", label: "Funder amounts", description: "rates and totals billed to the funder", requiresMoney: true },
  { key: "canSeeEmployeeAmounts", label: "Employee amounts", description: "base amounts earned or payable", requiresMoney: true },
  { key: "canSeeAgencySpread", label: "Agency spread", description: "the billed-to-base difference", requiresMoney: true },
  { key: "canSeeCheckNet", label: "Check net", description: "net pay recorded on employee checks", requiresMoney: true },
  { key: "canSeeTaxes", label: "Taxes and withholding", description: "gross, net and payroll withholding details", requiresMoney: true },
  { key: "canSeeBudgets", label: "Budgets", description: "individual budgets and financial plans; enabling this also enables Hours" },
  { key: "canSeeEmployeeDeals", label: "Employee deals", description: "deal terms and calculated obligations", requiresMoney: true },
  { key: "canSeeSettlements", label: "Settlements", description: "balances, payments and action history", requiresMoney: true },
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
        {role === "admin" ? "Administrators" : "Managers"} see everything — access scoping applies to the read-only <span className="font-medium">viewer</span> role.
      </p>
    );
  }
  const scoped = value.accessScope === "scoped";
  const set = (patch: Partial<AccessState>) => onChange({ ...value, ...patch });
  const setVisibility = (key: VisibilityKey, checked: boolean) => {
    if (key === "canSeeHours" && !checked) {
      set({ canSeeHours: false, canSeeBudgets: false });
      return;
    }
    if (key === "canSeeBudgets" && checked) {
      set({ canSeeBudgets: true, canSeeHours: true });
      return;
    }
    set({ [key]: checked } as Partial<AccessState>);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => set({ accessScope: "full" })}
          className={`btn btn-sm ${!scoped ? "btn-primary" : "btn-secondary"}`}
        >
          Sees everything
        </button>
        <button
          type="button"
          onClick={() => set({ accessScope: "scoped" })}
          className={`btn btn-sm ${scoped ? "btn-primary" : "btn-secondary"}`}
        >
          Limit to certain people
        </button>
      </div>

      {scoped ? (
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
        <input type="checkbox" checked={value.canSeeMoney} onChange={(e) => set({ canSeeMoney: e.target.checked })} />
        <span className="font-medium">Allow dollar amounts</span>
        <span className="text-xs text-[var(--color-ink-faint)]">master switch for every money permission below</span>
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
  const [form, setForm] = useState({ email: "", displayName: "", password: "", role: "viewer" });
  const [addAccess, setAddAccess] = useState<AccessState>(emptyAccess());

  // Per-user edit panel.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAccess, setEditAccess] = useState<AccessState | null>(null);
  const [editRole, setEditRole] = useState<string>("viewer");
  const [newPassword, setNewPassword] = useState("");
  const [loadingEdit, setLoadingEdit] = useState(false);
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
      setEditingId(null);
      return;
    }
    setEditingId(u.id);
    loadAccess(u.id, u.role);
  }

  async function loadAccess(userId: string, role: string) {
    setEditRole(role);
    setNewPassword("");
    setEditAccess(null);
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
          individualIds: string[];
          employeeIds: string[];
        };
      };
      if (data.ok && data.access) {
        setEditAccess({
          accessScope: data.access.accessScope,
          seeAllIndividuals: data.access.seeAllIndividuals,
          seeAllEmployees: data.access.seeAllEmployees,
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
          individualIds: new Set(data.access.individualIds),
          employeeIds: new Set(data.access.employeeIds),
        });
      } else {
        // Loading failed — do NOT default to full access; block saving instead.
        setEditAccess(null);
        setEditLoadFailed(true);
      }
    } catch {
      setEditAccess(null);
      setEditLoadFailed(true);
    } finally {
      setLoadingEdit(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editAccess) {
      setError("Couldn't load this person's current access. Close and reopen before saving so nothing is reset by accident.");
      return;
    }
    const body: Record<string, unknown> = { role: editRole, ...accessToBody(editAccess) };
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
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, ...accessToBody(addAccess) }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) setError(data.error ?? "The account could not be created.");
      else {
        setNotice(`Account created for ${form.email}. Give them this password directly — it isn't emailed or shown again.`);
        setForm({ email: "", displayName: "", password: "", role: "viewer" });
        setAddAccess(emptyAccess());
        setAddOpen(false);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const accessSummary = (u: UserRow) => {
    if (u.role !== "viewer") return "Sees everything";
    const parts: string[] = [];
    if (u.accessScope === "full") {
      parts.push("all people");
    } else {
      parts.push(u.seeAllIndividuals ? "all individuals" : `${u.individualCount} individual${u.individualCount === 1 ? "" : "s"}`);
      parts.push(u.seeAllEmployees ? "all employees" : `${u.employeeCount} employee${u.employeeCount === 1 ? "" : "s"}`);
    }
    if (!u.canSeeTransactions) parts.push("no transactions");
    if (!u.canSeeMoney) parts.push("hours only");
    const visibleCategories = VISIBILITY_OPTIONS.filter(
      (option) => u[option.key] && (!option.requiresMoney || u.canSeeMoney),
    ).length;
    if (visibleCategories < VISIBILITY_OPTIONS.length) {
      parts.push(`${visibleCategories}/${VISIBILITY_OPTIONS.length} info areas`);
    }
    return parts.join(" · ");
  };

  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]">
      <header className="flex items-center justify-between border-b border-[var(--color-rule)] px-5 py-3">
        <div>
          <h2 className="display text-base font-medium">Users &amp; access</h2>
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
            There&rsquo;s no public sign-up. Give people a login and choose exactly what they can see.
          </p>
        </div>
        <button type="button" onClick={() => setAddOpen((v) => !v)} className="btn btn-sm btn-primary">
          {addOpen ? "Close" : "Add a user"}
        </button>
      </header>

      {error ? (
        <p role="alert" className="mx-5 mt-3 rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mx-5 mt-3 rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">{notice}</p>
      ) : null}

      {addOpen ? (
        <form onSubmit={onCreate} className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-5 py-4">
          <h3 className="text-sm font-semibold">New account</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <label className="block text-sm">
              <span className="text-xs font-medium">Email</span>
              <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input mt-1 w-full text-sm" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium">Display name</span>
              <input required type="text" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="input mt-1 w-full text-sm" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium">Initial password</span>
              <input required minLength={10} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" className="input mt-1 w-full text-sm" placeholder="10+ characters" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium">Role</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="input mt-1 w-full text-sm">
                <option value="viewer">Viewer (read-only)</option>
                <option value="manager">Manager</option>
                <option value="admin">Administrator</option>
              </select>
            </label>
          </div>
          <div className="mt-4">
            <AccessConfig value={addAccess} onChange={setAddAccess} individuals={individuals} employees={employees} role={form.role} />
          </div>
          <button type="submit" disabled={busy} className="btn btn-primary mt-4">Create account</button>
        </form>
      ) : null}

      <div className="divide-y divide-[var(--color-rule)]">
        {users.map((u) => {
          const self = u.id === currentUserId;
          const open = editingId === u.id;
          return (
            <div key={u.id}>
              <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[var(--color-ink)]">
                    {u.displayName}
                    {!u.isActive ? <span className="ml-2 rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-[0.7rem] text-[var(--color-ink-faint)]">disabled</span> : null}
                  </p>
                  <p className="text-xs text-[var(--color-ink-faint)]">{u.email} · {u.role} · {accessSummary(u)}</p>
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
                      {open ? "Close" : "Edit access"}
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
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block text-sm">
                          <span className="text-xs font-medium">Role</span>
                          <select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="input mt-1 w-full text-sm">
                            <option value="viewer">Viewer (read-only)</option>
                            <option value="manager">Manager</option>
                            <option value="admin">Administrator</option>
                          </select>
                        </label>
                        <label className="block text-sm">
                          <span className="text-xs font-medium">Reset password (optional)</span>
                          <input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" placeholder="Leave blank to keep current" className="input mt-1 w-full text-sm" />
                        </label>
                      </div>
                      <AccessConfig value={editAccess} onChange={setEditAccess} individuals={individuals} employees={employees} role={editRole} />
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

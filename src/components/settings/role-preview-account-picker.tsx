"use client";

import { useMemo, useState } from "react";
import { LogIn, UserRound } from "lucide-react";
import type { RolePreviewAccount } from "@/lib/auth/role-preview";

function formatDirectLogin(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "A sign-in timestamp exists, but its date is unavailable.";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function namedSummary(names: readonly string[], noun: string): string | null {
  if (names.length === 0) return null;
  const visible = names.slice(0, 2).join(", ");
  const remainder = names.length - 2;
  return `${names.length} linked ${noun}: ${visible}${remainder > 0 ? ` +${remainder} more` : ""}`;
}

function scopeSummary(account: RolePreviewAccount): string[] {
  const result: string[] = [];
  const individuals = namedSummary(account.linkedIndividuals, account.linkedIndividuals.length === 1 ? "individual" : "individuals");
  const employees = namedSummary(account.linkedEmployees, account.linkedEmployees.length === 1 ? "employee" : "employees");
  if (individuals) result.push(individuals);
  if (employees) result.push(employees);

  for (const agency of account.linkedAgencies) {
    result.push(
      `${agency.name} (${agency.role.replaceAll("_", " ")}): ${agency.individualCount} individuals, ${agency.employeeCount} employees`,
    );
  }
  if (account.seeAllIndividuals) result.push("All individuals in the internal roster");
  else if (account.individualAccessCount > 0) result.push(`${account.individualAccessCount} explicitly assigned individuals`);
  if (account.seeAllEmployees) result.push("All employees in the internal roster");
  else if (account.employeeAccessCount > 0) result.push(`${account.employeeAccessCount} explicitly assigned employees`);
  return result;
}

export default function RolePreviewAccountPicker({
  accounts,
  presetLabel,
}: {
  accounts: RolePreviewAccount[];
  presetLabel: string;
}) {
  const [selectedId, setSelectedId] = useState(accounts[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const selected = useMemo(
    () => accounts.find((account) => account.id === selectedId) ?? accounts[0],
    [accounts, selectedId],
  );

  if (!selected) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-4 py-4 text-sm">
        <p className="font-medium text-[var(--color-ink)]">No active matching account</p>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          Create or activate a {presetLabel.toLowerCase()} account before previewing this preset.
        </p>
      </div>
    );
  }

  const scopes = scopeSummary(selected);
  const selectId = `role-preview-${presetLabel.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;

  return (
    <form
      method="post"
      action="/api/auth/impersonation/start"
      className="space-y-3"
      onSubmit={() => setSubmitting(true)}
    >
      <div>
        {accounts.length > 1 ? (
          <>
            <label htmlFor={selectId} className="eyebrow">Representative active account</label>
            <select
              id={selectId}
              name="targetUserId"
              value={selected.id}
              onChange={(event) => setSelectedId(event.target.value)}
              className="input mt-1 w-full text-sm"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName} — {account.email}{account.isCurrent ? " (current account)" : ""}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <p id={`${selectId}-label`} className="eyebrow">Representative active account</p>
            <input type="hidden" name="targetUserId" value={selected.id} />
            <div aria-labelledby={`${selectId}-label`} className="mt-1 flex items-start gap-2 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
              <UserRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{selected.displayName}</span>
                <span className="block truncate text-xs text-[var(--color-ink-faint)]">{selected.email}</span>
              </span>
            </div>
          </>
        )}
      </div>

      <dl className="space-y-2 text-xs leading-relaxed">
        <div>
          <dt className="font-semibold text-[var(--color-ink)]">Linked scope</dt>
          <dd className="text-[var(--color-ink-soft)]">
            {scopes.length > 0 ? scopes.join(" · ") : "No linked person, employee, agency, or explicit roster grant was found."}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-[var(--color-ink)]">Direct-login evidence</dt>
          <dd className="text-[var(--color-ink-soft)]">
            {selected.lastLoginAt
              ? `Direct sign-in recorded ${formatDirectLogin(selected.lastLoginAt)}.`
              : "No direct sign-in is recorded for this account."}
            {" "}This is account-use evidence, not formal role acceptance.
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="font-semibold text-[var(--color-ink)]">Direct-login acceptance</dt>
          <dd className="rounded-full bg-[var(--color-warn-soft)] px-2 py-0.5 font-semibold text-[var(--color-warn)]">Not formally recorded</dd>
        </div>
      </dl>

      <section className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3.5 py-3">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Selected account — effective internal access</h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">
          Server-derived from this account. Portal links and agency scope are listed above; the preset description is intent, not a substitute for these effective permissions.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <h4 className="text-xs font-semibold text-[var(--color-success)]">Granted now</h4>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">
              {selected.effectiveGrants.length > 0
                ? selected.effectiveGrants.join(" · ")
                : "No internal workspace grants are active."}
            </p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-[var(--color-ink)]">Denied now</h4>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">
              {selected.effectiveDenials.length > 0
                ? selected.effectiveDenials.join(" · ")
                : "No internal workspace denials are active."}
            </p>
          </div>
        </div>
      </section>

      {selected.portalScopes.length > 0 ? (
        <section className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3.5 py-3">
          <h3 className="text-sm font-semibold text-[var(--color-ink)]">Selected account — effective portal access</h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">
            Server-derived for each linked person or agency. Preset defaults and owner adjustments are combined here; an explicit denial wins.
          </p>
          <div className="mt-3 space-y-3">
            {selected.portalScopes.map((scope) => (
              <div key={scope.key} className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2.5">
                <h4 className="text-xs font-semibold text-[var(--color-ink)]">{scope.label}</h4>
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-[var(--color-success)]">Granted now</dt>
                    <dd className="mt-0.5 leading-relaxed text-[var(--color-ink-soft)]">
                      {scope.effectiveGrants.length > 0
                        ? scope.effectiveGrants.join(" · ")
                        : "No portal capability is active for this scope."}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[var(--color-ink)]">Explicitly denied</dt>
                    <dd className="mt-0.5 leading-relaxed text-[var(--color-ink-soft)]">
                      {scope.effectiveDenials.length > 0
                        ? scope.effectiveDenials.join(" · ")
                        : "No explicit denial is stored for this scope."}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <button
        type="submit"
        disabled={selected.isCurrent || submitting}
        aria-busy={submitting}
        className="btn btn-primary w-full"
        title={selected.isCurrent ? "You are already signed in as this owner" : `Sign in as ${selected.displayName}`}
      >
        <LogIn aria-hidden className="h-4 w-4" />
        {selected.isCurrent
          ? "Current owner account"
          : submitting
            ? "Opening…"
            : "Preview / Sign in as"}
      </button>
    </form>
  );
}

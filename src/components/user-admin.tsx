"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
}

/** Administrator user management. Every action is enforced again on the server. */
export default function UserAdmin({
  currentUserId,
  initialUsers,
}: {
  currentUserId: string;
  initialUsers: UserRow[];
}) {
  const router = useRouter();
  const [users] = useState(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) setError(data.error ?? "That change was rejected.");
      else {
        setNotice("Saved.");
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(data.get("email") ?? ""),
          displayName: String(data.get("displayName") ?? ""),
          password: String(data.get("password") ?? ""),
          role: String(data.get("role") ?? "viewer"),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) setError(body.error ?? "The account could not be created.");
      else {
        form.reset();
        setNotice("Account created. Give the person their password directly; it is not emailed or displayed again.");
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]">
      <header className="border-b border-[var(--color-rule)] px-5 py-3">
        <h2 className="display text-base font-medium">User access</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
          There is no public sign-up. Accounts exist only because an administrator created them.
        </p>
      </header>

      {error ? (
        <p role="alert" className="mx-5 mt-3 rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mx-5 mt-3 rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">{notice}</p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Accounts with their role and state</caption>
          <thead>
            <tr className="border-b border-[var(--color-rule)] text-left">
              <th scope="col" className="px-4 py-2 text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Account</th>
              <th scope="col" className="px-4 py-2 text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Role</th>
              <th scope="col" className="px-4 py-2 text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Last sign-in</th>
              <th scope="col" className="px-4 py-2 text-xs font-semibold uppercase text-[var(--color-ink-faint)]">State</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === currentUserId;
              return (
                <tr key={u.id} className="border-b border-[var(--color-rule)] last:border-0">
                  <td className="px-4 py-2">
                    {u.displayName}
                    <p className="text-xs text-[var(--color-ink-faint)]">{u.email}</p>
                  </td>
                  <td className="px-4 py-2">
                    <label className="sr-only" htmlFor={`role-${u.id}`}>Role for {u.email}</label>
                    <select
                      id={`role-${u.id}`}
                      defaultValue={u.role}
                      disabled={self || busy}
                      onChange={(e) => patch(u.id, { role: e.target.value })}
                      className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm disabled:opacity-60"
                    >
                      <option value="viewer">viewer</option>
                      <option value="manager">manager</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}
                  </td>
                  <td className="px-4 py-2">
                    {self ? (
                      <span className="text-xs text-[var(--color-ink-faint)]">This is you</span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => patch(u.id, { isActive: !u.isActive })}
                        className="rounded border border-[var(--color-rule-strong)] px-2 py-1 text-xs disabled:opacity-60"
                      >
                        {u.isActive ? "Disable" : "Enable"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <form onSubmit={onCreate} className="border-t border-[var(--color-rule)] px-5 py-4">
        <h3 className="text-sm font-medium">Create an account</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div>
            <label className="block text-sm font-medium" htmlFor="new-email">Email</label>
            <input id="new-email" name="email" type="email" required className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="new-name">Display name</label>
            <input id="new-name" name="displayName" type="text" required className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="new-password">Initial password</label>
            <input id="new-password" name="password" type="password" minLength={10} required autoComplete="new-password" className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="new-role">Role</label>
            <select id="new-role" name="role" defaultValue="viewer" className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm">
              <option value="viewer">viewer</option>
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <button type="submit" disabled={busy} className="mt-3 rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          Create account
        </button>
      </form>
    </section>
  );
}

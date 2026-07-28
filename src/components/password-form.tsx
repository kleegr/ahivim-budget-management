"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Change your own password. Succeeding signs you out on purpose. */
export default function PasswordForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirm = String(form.get("confirmPassword") ?? "");
    setError(null);
    setDone(null);

    if (newPassword !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: String(form.get("currentPassword") ?? ""),
          newPassword,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!response.ok || !body.ok) {
        setError(body.error ?? "The password could not be changed.");
        setBusy(false);
        return;
      }
      setDone(body.message ?? "Password changed.");
      setTimeout(() => {
        router.push("/signin?notice=Your%20password%20was%20changed.%20Sign%20in%20again.");
        router.refresh();
      }, 1200);
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="px-5 py-4">
      <h3 className="text-sm font-medium">Change your password</h3>
      <p className="mt-1 max-w-prose text-xs text-[var(--color-ink-faint)]">
        At least 10 characters, and different from your current one. Changing it signs you out so
        the new password is used from here on.
      </p>

      {error ? (
        <p role="alert" className="mt-3 rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">{error}</p>
      ) : null}
      {done ? (
        <p role="status" className="mt-3 rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">{done}</p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-sm font-medium" htmlFor="currentPassword">Current password</label>
          <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required
            className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="newPassword">New password</label>
          <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={10} required
            className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="confirmPassword">Confirm new password</label>
          <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required
            className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
        </div>
      </div>

      <button type="submit" disabled={busy}
        className="mt-3 rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}

"use client";

import { useState } from "react";

/** Lets a manager choose which screen everyone lands on from the app root. */
export default function DefaultLanding({ current }: { current: string }) {
  const [value, setValue] = useState(current || "dashboard");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string) => {
    setValue(next);
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/settings/default-landing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: next }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "The home-page choice could not be saved. Try again.");
        return;
      }
      setSaved(true);
    } catch {
      setError("The server could not be reached. Your choice was not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="inline-flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[var(--color-ink-soft)]">When I open the app, start on</span>
        <select
          value={value}
          onChange={(e) => void save(e.target.value)}
          disabled={busy}
          aria-busy={busy}
          className="select min-h-11"
        >
          <option value="dashboard">Home</option>
          <option value="transactions">Transactions</option>
          <option value="individuals">People &amp; budgets</option>
          <option value="calculations">Financial setup</option>
        </select>
        {saved ? <span role="status" className="text-xs text-[var(--color-success)]">Saved.</span> : null}
      </label>
      {error ? <p role="alert" className="mt-1 text-sm text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}

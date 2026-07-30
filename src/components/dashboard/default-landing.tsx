"use client";

import { useState } from "react";

/** Lets a manager choose which screen everyone lands on from the app root. */
export default function DefaultLanding({ current }: { current: string }) {
  const [value, setValue] = useState(current || "dashboard");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (next: string) => {
    setValue(next);
    setBusy(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/default-landing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: next }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="text-[var(--color-text-soft)]">When I open the app, start on</span>
      <select
        value={value}
        onChange={(e) => save(e.target.value)}
        disabled={busy}
        className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1"
      >
        <option value="dashboard">Dashboard</option>
        <option value="transactions">Transactions</option>
        <option value="calculations">Calculations</option>
      </select>
      {saved && <span className="text-xs text-[var(--color-text-soft)]">Saved</span>}
    </label>
  );
}

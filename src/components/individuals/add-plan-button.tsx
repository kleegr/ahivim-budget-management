"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Add a second (or third) financial plan to an individual. Most people have one
 * plan; some need two — different programs on different cuts. This creates a new,
 * empty plan you can then fill in (add its programs and set its cuts) right on the
 * profile, exactly like the first.
 */
export default function AddPlanButton({ individualId, nextLabel }: { individualId: string; nextLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/calculation-strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ individualId, label: nextLabel }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not add a plan.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add a plan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button type="button" onClick={add} disabled={busy} className="btn btn-sm btn-secondary">
        {busy ? "Adding…" : "+ Add another financial plan"}
      </button>
      <span className="text-xs text-[var(--color-ink-faint)]">Use a second projection for different programs or cuts.</span>
      {error ? <span className="text-xs text-[var(--color-danger)]">{error}</span> : null}
    </div>
  );
}

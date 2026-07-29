"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * One-click employee-payment attribution back-fill for administrators.
 *
 * Classifies every payroll transaction (employee / Excellent Staffing /
 * unknown) and records the agency-additional and employee-payment amounts on
 * the three newer columns. It never touches the imported figures and is safe to
 * run repeatedly — each run simply re-derives the same classification.
 */
export default function AttributePayments() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!window.confirm("Re-classify payment attribution for every transaction now?")) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/attribute-payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; updated?: number; error?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `Attribution failed (${res.status}).`);
      } else {
        setResult(`Attributed ${body.updated ?? 0} transaction${body.updated === 1 ? "" : "s"}.`);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }

  return (
    <div className="border-t border-[var(--color-rule)] px-5 py-4">
      <p className="max-w-prose text-sm text-[var(--color-ink-soft)]">
        Attribute each payroll transaction to the employee, to Excellent Staffing, or to
        &ldquo;unknown&rdquo;, and record the agency-additional amount. This only writes the
        attribution columns; the imported amounts are never changed.
      </p>
      {error ? (
        <p role="alert" className="mt-3 rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">
          {error}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="mt-3 rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">
          {result}
        </p>
      ) : null}
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="mt-3 rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? "Attributing…" : "Back-fill payment attribution"}
      </button>
    </div>
  );
}

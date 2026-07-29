"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * One-click migration runner for administrators. The migration runner is
 * idempotent (each file applies once, recorded with a checksum), so this is
 * safe to press repeatedly; it reports what it applied or skipped.
 */
export default function ApplyMigrations() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!window.confirm("Apply any pending database migrations now?")) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/migrate", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; applied?: number; skipped?: number; tableCount?: number; reason?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.reason ?? `Migration failed (${res.status}).`);
      } else {
        setResult(`Applied ${body.applied ?? 0}, skipped ${body.skipped ?? 0}. ${body.tableCount ?? "?"} tables present.`);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }

  return (
    <div className="px-5 py-4">
      <p className="max-w-prose text-sm text-[var(--color-ink-soft)]">
        Apply any database migrations that have shipped with a new release. Safe to run at any time —
        already-applied migrations are skipped.
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
        {busy ? "Applying…" : "Apply pending migrations"}
      </button>
    </div>
  );
}

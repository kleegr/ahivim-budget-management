"use client";

import Link from "next/link";
import { AlertTriangle, House, RefreshCw } from "lucide-react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="mx-auto flex min-h-[50vh] max-w-xl items-center px-4 py-12" aria-labelledby="app-error-title">
      <div role="alert" className="w-full rounded-lg border border-[var(--color-danger)] bg-[var(--color-surface)] p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded bg-[var(--color-danger-soft)] text-[var(--color-danger)]">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </span>
          <div>
            <p className="eyebrow text-[var(--color-danger)]">Page error</p>
            <h1 id="app-error-title" className="mt-1 text-xl font-semibold text-[var(--color-ink)]">
              This page could not be loaded
            </h1>
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              Try loading this view again. If the problem continues, return to the dashboard and reopen it.
            </p>
            {error.digest ? (
              <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                Reference: <span className="font-mono">{error.digest}</span>
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={reset} className="btn btn-primary">
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            Try again
          </button>
          <Link href="/home" className="btn btn-secondary">
            <House aria-hidden="true" className="h-4 w-4" />
            Dashboard
          </Link>
        </div>
      </div>
    </section>
  );
}

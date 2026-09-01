"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookmarkPlus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { GridView } from "@/lib/manage/grid-views";
import type { OwnerActivitySelection } from "@/lib/dashboard/owner-summary";
import { ownerViewHref } from "@/lib/dashboard/owner-views";

async function request(url: string, init: RequestInit): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    return response.ok && body.ok !== false
      ? { ok: true }
      : { ok: false, error: body.error ?? "The saved view could not be updated." };
  } catch {
    return { ok: false, error: "The server could not be reached. Nothing was changed." };
  }
}

export default function OwnerSavedViews({
  selection,
  views,
}: {
  selection: OwnerActivitySelection;
  views: GridView[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usableViews = views
    .map((view) => ({ ...view, href: ownerViewHref(view.config) }))
    .filter((view) => view.href !== null) as Array<GridView & { href: string }>;

  const hasSelection = Boolean(
    selection.checkDateFrom
      || selection.checkDateTo
      || selection.individualIds.length
      || selection.employeeId
      || selection.payrollPeriod,
  );

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy("save");
    setError(null);
    const result = await request("/api/grid-views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gridKey: "owner_dashboard", name: name.trim(), config: selection }),
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? "The view could not be saved.");
      return;
    }
    setName("");
    router.refresh();
  }

  async function remove(view: GridView) {
    if (!window.confirm(`Delete the saved view "${view.name}"?`)) return;
    setBusy(view.id);
    setError(null);
    const result = await request(`/api/grid-views/${encodeURIComponent(view.id)}?grid=owner_dashboard`, {
      method: "DELETE",
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? "The view could not be deleted.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-4 border-t border-[var(--color-rule)] pt-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Saved views</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Keep a group or payroll selection you use again.</p>
        </div>
        {hasSelection ? (
          <form onSubmit={save} className="flex w-full items-end gap-2 sm:w-auto">
            <label className="min-w-0 flex-1 sm:w-56">
              <span className="sr-only">Saved view name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required className="input w-full" placeholder="Name this view" />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy !== null || !name.trim()} aria-busy={busy === "save"}>
              <BookmarkPlus aria-hidden className="h-4 w-4" /> {busy === "save" ? "Saving..." : "Save view"}
            </button>
          </form>
        ) : null}
      </div>

      {usableViews.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {usableViews.map((view) => (
            <span key={view.id} className="inline-flex min-h-11 items-stretch border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
              <Link href={view.href} className="inline-flex items-center px-3 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-surface-muted)]">
                {view.name}
              </Link>
              <button type="button" aria-label={`Delete saved view ${view.name}`} title="Delete saved view" disabled={busy !== null} onClick={() => void remove(view)} className="btn btn-icon btn-ghost min-h-11 min-w-11 border-l border-[var(--color-rule)]">
                <Trash2 aria-hidden className="h-4 w-4" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">No saved views yet.</p>
      )}
      {error ? <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}

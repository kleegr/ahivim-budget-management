"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import type { SyncStatus, SyncRunRow, SyncConflictRow } from "@/lib/sheets/queries";
import type { SheetSyncConfig } from "@/lib/sheets/config";
import {
  friendlyActionError,
  importCorrectionsHref,
  transactionReviewHref,
} from "@/lib/nav/review-actions";
import {
  syncOutcomePresentation,
  syncRunActions,
} from "@/lib/nav/sync-actions";

interface Props {
  canManage: boolean;
  isAdmin: boolean;
  status: SyncStatus;
  config: SheetSyncConfig;
  runs: SyncRunRow[];
  conflicts: SyncConflictRow[];
  sheetUrl: string;
}

function fmt(dt: string | null): string {
  if (!dt) return "—";
  const d = new Date(dt);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const STATUS_TONE: Record<string, string> = {
  success: "var(--color-success)",
  no_changes: "var(--color-info)",
  running: "var(--color-warn)",
  failed: "var(--color-danger)",
};

export default function SyncConsole({ canManage, isAdmin, status, config, runs, conflicts, sheetUrl }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    tone: "ok" | "err";
    text: string;
    action?: { href: string; label: string } | null;
  } | null>(null);

  const changed = conflicts.filter((c) => c.type === "changed");
  const missing = conflicts.filter((c) => c.type === "missing");

  async function call(
    key: string,
    url: string,
    init: RequestInit,
    options: { acceptDomainFailure?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    setBusy(key);
    setBanner(null);
    try {
      const res = await fetch(url, init);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || (body.ok === false && !options.acceptDomainFailure)) {
        setBanner({ tone: "err", text: friendlyActionError(body.error, "That action could not be completed. Try again.") });
        return null;
      }
      return body;
    } catch {
      setBanner({ tone: "err", text: "Could not reach the server." });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    const body = await call(
      "sync",
      "/api/sync/run",
      { method: "POST" },
      { acceptDomainFailure: true },
    );
    if (body) {
      const outcome = syncOutcomePresentation(body.summary as Parameters<typeof syncOutcomePresentation>[0]);
      setBanner({ tone: outcome.tone, text: outcome.message, action: outcome.action });
      router.refresh();
    }
  }

  async function resolve(id: string, action: "apply" | "dismiss") {
    const body = await call(`${action}:${id}`, `/api/sync/conflicts/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (body) {
      setBanner({ tone: "ok", text: action === "apply" ? "Applied the sheet's value to the transaction." : "Conflict dismissed." });
      router.refresh();
    }
  }

  async function saveConfig(form: HTMLFormElement) {
    const data = new FormData(form);
    const payload = {
      enabled: data.get("enabled") === "on",
      sheetId: String(data.get("sheetId") ?? "").trim(),
      sheetName: String(data.get("sheetName") ?? "").trim(),
      scheduleHourUtc: Number(data.get("scheduleHourUtc")),
      minIntervalMinutes: Number(data.get("minIntervalMinutes")),
    };
    const body = await call("config", "/api/sync/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (body) {
      setBanner({ tone: "ok", text: "Sync settings saved." });
      router.refresh();
    }
  }

  async function clearHistory() {
    const body = await call("clear", "/api/sync/history", { method: "DELETE" });
    if (body) {
      setBanner({ tone: "ok", text: `Cleared ${String(body.deleted ?? 0)} run(s).` });
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      {banner ? (
        <div
          role={banner.tone === "err" ? "alert" : "status"}
          className={`rounded-lg border px-4 py-3 text-sm ${
            banner.tone === "ok"
              ? "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
              : "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
          }`}
        >
          <span>{banner.text}</span>
          {banner.action ? (
            <Link href={banner.action.href} className="ml-2 font-semibold underline underline-offset-2">
              {banner.action.label}
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* Status + Sync now */}
      <section className="card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Source of truth</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Transactions are synced from{" "}
              <a className="underline underline-offset-2" href={sheetUrl} target="_blank" rel="noreferrer">
                the Google Sheet
              </a>
              . The daily automated sync imports new rows and flags any change or removal for review.
            </p>
          </div>
          {canManage ? (
            <button
              type="button"
              onClick={syncNow}
              disabled={busy !== null}
              className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Last successful sync" value={fmt(status.lastSuccessAt)} />
          <Tile label="Changes to review" value={String(status.openChanged)} tone={status.openChanged ? "var(--color-warn)" : undefined} />
          <Tile label="Missing rows to review" value={String(status.openMissing)} tone={status.openMissing ? "var(--color-danger)" : undefined} />
          <Tile label="Tracked transactions" value={status.trackedRows.toLocaleString()} />
        </div>

        {status.lastRun ? (
          <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
            Most recent run: <span style={{ color: STATUS_TONE[status.lastRun.status] }}>{status.lastRun.status.replace(/_/g, " ")}</span>{" "}
            ({status.lastRun.trigger}) · added {status.lastRun.added}, updated {status.lastRun.updated}, skipped{" "}
            {status.lastRun.skipped}, flagged {status.lastRun.flagged}, failed {status.lastRun.failed}
            {status.lastRun.errorMessage ? ` · ${friendlyActionError(status.lastRun.errorMessage, "The run did not finish.")}` : ""}
          </p>
        ) : null}
      </section>

      {/* Conflicts */}
      <section
        id="sync-conflicts"
        className="card scroll-mt-24 overflow-hidden target:outline target:outline-2 target:outline-offset-2 target:outline-[var(--color-primary)]"
      >
          <header className="border-b border-[var(--color-rule)] px-5 py-3.5">
            <h2 className="display text-[0.95rem] font-semibold">Needs review</h2>
            <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
              The sync never overwrites or deletes a transaction on its own. Changed and missing source rows wait here.
            </p>
          </header>

          {changed.length === 0 && missing.length === 0 ? (
            <div className="px-5 py-6 text-sm text-[var(--color-success)]">
              All synced source changes have been reviewed.
            </div>
          ) : null}

          {changed.length > 0 ? (
            <div className="px-5 py-4">
              <p className="eyebrow mb-2">Changed in the sheet ({changed.length})</p>
              <ul className="space-y-3">
                {changed.map((c) => (
                  <li key={c.id} className="rounded-lg border border-[var(--color-rule)] px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {c.individualName ?? "—"}{" "}
                          <span className="text-[var(--color-ink-faint)]">· {c.programName ?? "—"} · {c.employeeName ?? "—"}</span>
                          {c.audited ? (
                            <span className="ml-2 rounded-full bg-[var(--color-danger-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-danger)]">
                              audited — protected
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                          {money(c.previous, "amount")} → {money(c.incoming, "amount")} ·{" "}
                          {hours(c.previous)} → {hours(c.incoming)}
                        </p>
                        {c.detail ? <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{c.detail}</p> : null}
                        <div className="mt-2 flex flex-wrap gap-3 text-xs font-semibold">
                          {c.transactionId ? <Link className="text-[var(--color-primary)] underline-offset-2 hover:underline" href={transactionReviewHref(c.transactionId)}>Open transaction</Link> : null}
                          {c.sourceFileId && c.importRowId ? <Link className="text-[var(--color-primary)] underline-offset-2 hover:underline" href={importCorrectionsHref(c.sourceFileId, c.importRowId)}>Review source row</Link> : null}
                        </div>
                      </div>
                      {canManage ? (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => resolve(c.id, "apply")}
                            disabled={busy !== null || c.audited}
                            title={c.audited ? "Resolve the audited correction first" : "Apply the sheet's value"}
                            className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                          >
                            {busy === `apply:${c.id}` ? "Applying…" : "Apply"}
                          </button>
                          <button
                            type="button"
                            onClick={() => resolve(c.id, "dismiss")}
                            disabled={busy !== null}
                            className="btn btn-sm btn-secondary"
                          >
                            Keep existing
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {missing.length > 0 ? (
            <div className="border-t border-[var(--color-rule)] px-5 py-4">
              <p className="eyebrow mb-2">Removed from the sheet ({missing.length})</p>
              <ul className="space-y-3">
                {missing.map((c) => (
                  <li key={c.id} className="rounded-lg border border-[var(--color-rule)] px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {c.individualName ?? "—"}{" "}
                          <span className="text-[var(--color-ink-faint)]">· {c.programName ?? "—"} · {c.employeeName ?? "—"}</span>
                        </p>
                        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                          {money(c.previous, "amount")} · This transaction is no longer in the sheet. It was not deleted.
                        </p>
                        {c.transactionId ? (
                          <Link className="mt-2 inline-block text-xs font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={transactionReviewHref(c.transactionId)}>
                            Open transaction
                          </Link>
                        ) : null}
                      </div>
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => resolve(c.id, "dismiss")}
                          disabled={busy !== null}
                          className="btn btn-sm btn-secondary"
                        >
                          Keep &amp; dismiss
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
      </section>

      {/* Configuration */}
      <section
        id="sync-settings"
        className="card scroll-mt-24 overflow-hidden target:outline target:outline-2 target:outline-offset-2 target:outline-[var(--color-primary)]"
      >
        <header className="border-b border-[var(--color-rule)] px-5 py-3.5">
          <h2 className="display text-[0.95rem] font-semibold">Schedule &amp; source</h2>
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
            The sheet is checked automatically every day. {isAdmin ? "Change the settings below." : "An administrator manages these settings."}
          </p>
        </header>
        <form
          className="grid gap-4 px-5 py-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveConfig(e.currentTarget);
          }}
        >
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="enabled" defaultChecked={config.enabled} disabled={!isAdmin} />
            Daily automated sync enabled
          </label>
          <Field label="Google Sheet id" name="sheetId" defaultValue={config.sheetId} disabled={!isAdmin} />
          <Field label="Tab name" name="sheetName" defaultValue={config.sheetName} disabled={!isAdmin} />
          <Field label="Run hour (UTC, 0–23)" name="scheduleHourUtc" type="number" defaultValue={String(config.scheduleHourUtc)} disabled={!isAdmin} />
          <Field label="Min minutes between runs" name="minIntervalMinutes" type="number" defaultValue={String(config.minIntervalMinutes)} disabled={!isAdmin} />
          {isAdmin ? (
            <div className="sm:col-span-2">
              <button type="submit" disabled={busy !== null} className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
                {busy === "config" ? "Saving…" : "Save settings"}
              </button>
            </div>
          ) : null}
        </form>
      </section>

      {/* History */}
      <section
        id="sync-history"
        className="card scroll-mt-24 overflow-hidden target:outline target:outline-2 target:outline-offset-2 target:outline-[var(--color-primary)]"
      >
        <header className="flex items-center justify-between border-b border-[var(--color-rule)] px-5 py-3.5">
          <div>
            <h2 className="display text-[0.95rem] font-semibold">Sync history</h2>
            <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">Every run, with its counts and any error.</p>
          </div>
          {isAdmin && runs.length > 0 ? (
            <button type="button" onClick={clearHistory} disabled={busy !== null} className="btn btn-sm btn-secondary">
              {busy === "clear" ? "Clearing…" : "Clear history"}
            </button>
          ) : null}
        </header>
        {runs.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-[var(--color-ink-soft)]">No syncs have run yet.</div>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-left">
                  <Th>Started</Th><Th>Trigger</Th><Th>Status</Th>
                  <Th numeric>Added</Th><Th numeric>Updated</Th><Th numeric>Skipped</Th>
                  <Th numeric>Flagged</Th><Th numeric>Failed</Th><Th>Detail</Th><Th><span className="sr-only">Open</span></Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const actions = syncRunActions(r);
                  return (
                    <tr key={r.id} className="border-b border-[var(--color-rule)] last:border-0">
                    <td className="px-4 py-2.5 align-top text-xs">{fmt(r.startedAt)}</td>
                    <td className="px-4 py-2.5 align-top">{r.trigger}</td>
                    <td className="px-4 py-2.5 align-top" style={{ color: STATUS_TONE[r.status] }}>{r.status.replace(/_/g, " ")}</td>
                    <td className="px-4 py-2.5 text-right tnum">{r.added}</td>
                    <td className="px-4 py-2.5 text-right tnum">{r.updated}</td>
                    <td className="px-4 py-2.5 text-right tnum">{r.skipped}</td>
                    <td className="px-4 py-2.5 text-right tnum">{r.flagged}</td>
                    <td className="px-4 py-2.5 text-right tnum">{r.failed}</td>
                    <td className="px-4 py-2.5 align-top text-xs text-[var(--color-ink-faint)]">
                      {r.errorMessage
                        ? friendlyActionError(r.errorMessage, "The run did not finish. Review the source settings and try again.")
                        : r.reconciliationNote ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 align-top text-xs">
                      {actions.length > 0 ? (
                        <div className="flex min-w-24 flex-col items-start gap-1">
                          {actions.map((action) => (
                            <Link key={`${action.href}:${action.label}`} className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={action.href}>
                              {action.label}
                            </Link>
                          ))}
                        </div>
                      ) : "—"}
                    </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className="tnum mt-1 text-lg font-semibold leading-tight" style={tone ? { color: tone } : undefined}>{value}</p>
    </div>
  );
}

function Field({ label, name, defaultValue, type = "text", disabled }: { label: string; name: string; defaultValue: string; type?: string; disabled?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        disabled={disabled}
        className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm disabled:bg-[var(--color-surface-muted)]"
      />
    </label>
  );
}

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th className={`px-4 py-2.5 text-[0.6875rem] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase ${numeric ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function money(obj: Record<string, unknown> | null, key: string): string {
  const v = obj?.[key];
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(v);
}

function hours(obj: Record<string, unknown> | null): string {
  const v = obj?.hours;
  if (v === undefined || v === null || v === "") return "—";
  return `${v}h`;
}

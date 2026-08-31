import { friendlyActionError, importCorrectionsHref } from "@/lib/nav/review-actions";

export const SYNC_CONFLICTS_HREF = "/sync#sync-conflicts";
export const SYNC_HISTORY_HREF = "/sync#sync-history";
export const SYNC_SETTINGS_HREF = "/sync#sync-settings";

export interface SyncRunActionInput {
  status: string;
  flagged: number;
  failed: number;
  sourceFileId: string | null;
}

export interface SyncRunAction {
  href: string;
  label: "Review conflicts" | "Fix failed rows" | "Review source" | "Open import";
}

/**
 * A flagged source change belongs to the sync conflict queue. Import
 * corrections are only offered when the run actually held failed rows.
 */
export function syncRunActions(run: SyncRunActionInput): SyncRunAction[] {
  const actions: SyncRunAction[] = [];
  if (run.flagged > 0) {
    actions.push({ href: SYNC_CONFLICTS_HREF, label: "Review conflicts" });
  }
  if (run.failed > 0 && run.sourceFileId) {
    actions.push({ href: importCorrectionsHref(run.sourceFileId), label: "Fix failed rows" });
  }
  if (actions.length === 0 && run.status === "failed") {
    actions.push({ href: SYNC_SETTINGS_HREF, label: "Review source" });
  } else if (actions.length === 0 && run.sourceFileId) {
    actions.push({ href: `/imports/${encodeURIComponent(run.sourceFileId)}`, label: "Open import" });
  }
  return actions;
}

export interface SyncSummaryLike {
  status?: unknown;
  error?: unknown;
  note?: unknown;
}

export interface SyncOutcomePresentation {
  tone: "ok" | "err";
  message: string;
  action: { href: string; label: string } | null;
}

export interface SyncWritebackLike {
  status?: unknown;
  eligible?: unknown;
  updated?: unknown;
  skipped?: unknown;
  error?: unknown;
}

export interface SyncRoundTripLike {
  summary?: SyncSummaryLike | null;
  writeback?: SyncWritebackLike | null;
}

/** A domain-level failure is still a recorded run, so the UI should refresh. */
export function syncOutcomePresentation(summary: SyncSummaryLike | null | undefined): SyncOutcomePresentation {
  if (summary?.status === "failed") {
    const reason = friendlyActionError(summary.error, "The sync could not finish.");
    return {
      tone: "err",
      message: `${reason} The run was recorded; review it below or try again.`,
      action: { href: SYNC_HISTORY_HREF, label: "Open recorded run" },
    };
  }

  return {
    tone: "ok",
    message: typeof summary?.note === "string" && summary.note.trim()
      ? summary.note.trim()
      : "Sync complete.",
    action: null,
  };
}

/**
 * Present both halves of the one-button round trip. A successful pull must not
 * hide a failed or incomplete Paid-marker write-back, and a write-back failure
 * must not imply that the successful pull was discarded.
 */
export function syncRoundTripOutcomePresentation(
  result: SyncRoundTripLike | null | undefined,
): SyncOutcomePresentation {
  const pull = syncOutcomePresentation(result?.summary);
  if (pull.tone === "err") return pull;

  const writeback = result?.writeback;
  if (writeback?.status === "failed") {
    const reason = friendlyActionError(
      writeback.error,
      "Payment status changes could not be sent to the Google Sheet.",
    );
    return {
      tone: "err",
      message: `${reason} The latest Sheet information was still refreshed, and those payment changes remain pending.`,
      action: { href: SYNC_SETTINGS_HREF, label: "Review sync setup" },
    };
  }

  if (writeback?.status === "partial") {
    const skipped = Number(writeback.skipped);
    const count = Number.isFinite(skipped) && skipped > 0 ? Math.floor(skipped) : null;
    return {
      tone: "err",
      message: `The latest Sheet information was refreshed, but ${count === null ? "some" : count} payment ${count === 1 ? "change was" : "changes were"} not matched safely. Those changes remain pending.`,
      action: { href: "/sync", label: "Open sync details" },
    };
  }

  if (writeback?.status === "not_configured") {
    return {
      ...pull,
      message: `${pull.message} Payment write-back is not configured, so this refresh was read only.`,
    };
  }

  const updated = Number(writeback?.updated);
  if (writeback?.status === "success" && Number.isFinite(updated) && updated > 0) {
    const count = Math.floor(updated);
    return {
      ...pull,
      message: `${count} payment ${count === 1 ? "update was" : "updates were"} sent to the Google Sheet. ${pull.message}`,
    };
  }

  return pull;
}

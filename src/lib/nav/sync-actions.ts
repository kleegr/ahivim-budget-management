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

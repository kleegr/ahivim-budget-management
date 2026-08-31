import { describe, expect, it } from "vitest";
import {
  syncOutcomePresentation,
  syncRoundTripOutcomePresentation,
  syncRunActions,
} from "@/lib/nav/sync-actions";

describe("sync action destinations", () => {
  it("routes flagged changes to the conflict queue and failed rows to corrections", () => {
    expect(syncRunActions({ status: "success", flagged: 2, failed: 3, sourceFileId: "file-1" })).toEqual([
      { href: "/sync#sync-conflicts", label: "Review conflicts" },
      { href: "/imports/file-1/corrections", label: "Fix failed rows" },
    ]);
  });

  it("does not offer import corrections for a conflict-only run", () => {
    expect(syncRunActions({ status: "success", flagged: 2, failed: 0, sourceFileId: "file-1" })).toEqual([
      { href: "/sync#sync-conflicts", label: "Review conflicts" },
    ]);
  });

  it("routes a run-level failure without held rows to the source settings", () => {
    expect(syncRunActions({ status: "failed", flagged: 0, failed: 0, sourceFileId: null })).toEqual([
      { href: "/sync#sync-settings", label: "Review source" },
    ]);
  });

  it("presents a domain failure as a recorded, actionable run", () => {
    expect(syncOutcomePresentation({
      status: "failed",
      error: "The source sheet could not be reached.",
    })).toEqual({
      tone: "err",
      message: "The source sheet could not be reached. The run was recorded; review it below or try again.",
      action: { href: "/sync#sync-history", label: "Open recorded run" },
    });
  });

  it("does not hide a failed payment-marker write-back behind a successful pull", () => {
    expect(syncRoundTripOutcomePresentation({
      summary: { status: "success", note: "3 new rows loaded." },
      writeback: { status: "failed", error: "The Google Sheet write-back could not be completed." },
    })).toEqual({
      tone: "err",
      message: "The Google Sheet write-back could not be completed. The latest Sheet information was still refreshed, and those payment changes remain pending.",
      action: { href: "/sync#sync-settings", label: "Review sync setup" },
    });
  });

  it("labels a successful pull-only refresh honestly", () => {
    expect(syncRoundTripOutcomePresentation({
      summary: { status: "no_changes", note: "The sheet is unchanged." },
      writeback: { status: "not_configured" },
    })).toMatchObject({
      tone: "ok",
      message: "The sheet is unchanged. Payment write-back is not configured, so this refresh was read only.",
    });
  });

  it("reports partial matching and keeps the pending changes visible", () => {
    expect(syncRoundTripOutcomePresentation({
      summary: { status: "success", note: "Latest rows loaded." },
      writeback: { status: "partial", skipped: 1 },
    })).toEqual({
      tone: "err",
      message: "The latest Sheet information was refreshed, but 1 payment change was not matched safely. Those changes remain pending.",
      action: { href: "/sync", label: "Open sync details" },
    });
  });
});

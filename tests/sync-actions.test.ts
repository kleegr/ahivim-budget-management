import { describe, expect, it } from "vitest";
import {
  syncOutcomePresentation,
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
});

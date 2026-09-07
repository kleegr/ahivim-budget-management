import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSourceEvidenceConflict } from "@/lib/sheets/resolve";
import {
  canSkipVersionedSheetSnapshot,
  classifyChangedLedgerMatch,
  classifySourceEvidenceTransition,
  classifyTrackedSourcePresence,
  normalizedSourceEvidenceKeys,
  sourceOccurrenceDeficit,
  sourceOccurrenceEvidence,
  sourceOccurrenceEvidenceFromIdentity,
} from "@/lib/sheets/sync";

describe("versioned Sheet snapshot fast path", () => {
  it("forces one full migration-free tracking bootstrap before treating an unchanged Sheet as a no-op", () => {
    expect(canSkipVersionedSheetSnapshot({
      previousSha256: "same",
      previousSourceTrackingVersion: null,
      currentSha256: "same",
    })).toBe(false);
    expect(canSkipVersionedSheetSnapshot({
      previousSha256: "same",
      previousSourceTrackingVersion: "occurrence-v1+source-evidence-v2",
      currentSha256: "same",
    })).toBe(true);
    expect(canSkipVersionedSheetSnapshot({
      previousSha256: "same",
      previousSourceTrackingVersion: "occurrence-v1+source-evidence-v2",
      previousPendingAtomicGroupHolds: 1,
      currentSha256: "same",
    })).toBe(false);
    expect(canSkipVersionedSheetSnapshot({
      previousSha256: "old",
      previousSourceTrackingVersion: "occurrence-v1+source-evidence-v2",
      currentSha256: "new",
    })).toBe(false);
  });
});

describe("changed sheet row target safety", () => {
  it("selects a transaction only when the natural key has exactly one candidate", () => {
    const candidate = { id: "transaction-1" };

    expect(classifyChangedLedgerMatch([])).toEqual({ kind: "missing" });
    expect(classifyChangedLedgerMatch([candidate])).toEqual({ kind: "single", target: candidate });
  });

  it("holds an ambiguous natural key for review without choosing the first transaction", () => {
    const candidates = [{ id: "transaction-1" }, { id: "transaction-2" }];

    expect(classifyChangedLedgerMatch(candidates)).toEqual({ kind: "ambiguous", candidates });

    const syncSource = readFileSync(resolve("src/lib/sheets/sync.ts"), "utf8");
    expect(syncSource).not.toContain("const target = ledgerTxns[0]");
    expect(syncSource).toContain("VALUES ($1,NULL,'changed',false");
    expect(syncSource).toContain("It was NOT assigned or applied automatically");
    expect(syncSource).toContain("existing.sourcePaid = existing.sourcePaid || sourcePaid");
    expect(syncSource).toContain("source_no_longer_changed");
  });

  it("keeps the held source evidence visible and makes an untargeted change non-applicable", () => {
    const querySource = readFileSync(resolve("src/lib/sheets/queries.ts"), "utf8");
    const consoleSource = readFileSync(resolve("src/components/sync/sync-console.tsx"), "utf8");

    expect(querySource).toContain("c.incoming->>'sourceRowNumber'");
    expect(consoleSource).toContain("c.audited || !c.transactionId");
    expect(consoleSource).toContain("Clarify which existing transaction this source row belongs to before applying");
  });

  it("detects a missing line item even when another line shares its natural key", () => {
    const fingerprints = new Set(["still-present"]);
    const changedNaturalKeys = new Set<string>();
    const snapshot = { fingerprints, changedNaturalKeys };

    expect(classifyTrackedSourcePresence(
      { fingerprint: "still-present", naturalKey: "shared-key" },
      snapshot,
    )).toBe("present");
    expect(classifyTrackedSourcePresence(
      { fingerprint: "now-missing", naturalKey: "shared-key" },
      snapshot,
    )).toBe("missing");

    changedNaturalKeys.add("shared-key");
    expect(classifyTrackedSourcePresence(
      { fingerprint: "changed-old-value", naturalKey: "shared-key" },
      snapshot,
    )).toBe("changed");
  });

  it("compares exact-repeat multiplicity independently of source row order", () => {
    const twoOccurrences = sourceOccurrenceEvidence([14, 9]);
    const reordered = sourceOccurrenceEvidence([9, 14]);
    const oneOccurrence = sourceOccurrenceEvidence([14]);

    expect(twoOccurrences).toEqual({ sourceOccurrenceCount: 2, sourceRowNumbers: [9, 14] });
    expect(reordered).toEqual(twoOccurrences);
    expect(sourceOccurrenceDeficit(twoOccurrences, reordered)).toBe(0);
    expect(sourceOccurrenceDeficit(twoOccurrences, oneOccurrence)).toBe(1);
    expect(sourceOccurrenceDeficit(oneOccurrence, twoOccurrences)).toBe(0);
  });

  it("reads legacy single-row evidence and preserves a stored repeat count", () => {
    expect(sourceOccurrenceEvidenceFromIdentity({ employee: "Legacy" }, 22)).toEqual({
      sourceOccurrenceCount: 1,
      sourceRowNumbers: [22],
    });
    expect(sourceOccurrenceEvidenceFromIdentity({
      sourceOccurrenceCount: 2,
      sourceRowNumbers: [31],
    }, 31)).toEqual({
      sourceOccurrenceCount: 2,
      sourceRowNumbers: [31],
    });
  });

  it("bootstraps legacy routing/net evidence before detecting later drift", () => {
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: { employee: "Legacy" },
      currentKeys: ["evidence-a"],
    })).toMatchObject({ kind: "bootstrap", reason: null });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: { employee: "Legacy" },
      currentKeys: ["evidence-a", "evidence-b"],
    })).toMatchObject({ kind: "conflict", reason: "variants" });

    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: {
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a"],
      },
      currentKeys: ["evidence-b"],
    })).toEqual({
      kind: "conflict",
      reason: "changed",
      expectedKeys: ["evidence-a"],
      currentKeys: ["evidence-b"],
    });
  });

  it("holds conflicting variants once and restores only the marked evidence conflict", () => {
    expect(normalizedSourceEvidenceKeys(["evidence-b", "evidence-a", "evidence-b"]))
      .toEqual(["evidence-a", "evidence-b"]);
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: false,
      previousIdentity: null,
      currentKeys: ["evidence-b", "evidence-a"],
    })).toEqual({
      kind: "conflict",
      reason: "variants",
      expectedKeys: ["evidence-a", "evidence-b"],
      currentKeys: ["evidence-a", "evidence-b"],
    });
    const changedAcceptedVariants = classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: {
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a", "evidence-b"],
      },
      currentKeys: ["evidence-a", "evidence-c"],
    });
    expect(changedAcceptedVariants).toEqual({
      kind: "conflict",
      reason: "changed",
      expectedKeys: ["evidence-a", "evidence-b"],
      currentKeys: ["evidence-a", "evidence-c"],
    });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: null,
      currentKeys: ["evidence-d"],
      openConflictPrevious: {
        sourceEvidenceConflict: "routing_or_net",
        sourceEvidenceConflictReason: "changed",
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a", "evidence-b"],
      },
    })).toMatchObject({ kind: "conflict", reason: "changed" });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: null,
      currentKeys: ["evidence-a"],
      openConflictPrevious: {
        sourceEvidenceConflict: "routing_or_net",
        sourceEvidenceConflictReason: "changed",
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a", "evidence-b"],
      },
    })).toMatchObject({ kind: "conflict", reason: "changed" });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: {
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-b", "evidence-a"],
      },
      currentKeys: ["evidence-a"],
    })).toEqual({
      kind: "conflict",
      reason: "changed",
      expectedKeys: ["evidence-a", "evidence-b"],
      currentKeys: ["evidence-a"],
    });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: {
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-b", "evidence-a"],
      },
      currentKeys: ["evidence-a", "evidence-b"],
    })).toEqual({
      kind: "unchanged",
      reason: null,
      expectedKeys: ["evidence-a", "evidence-b"],
      currentKeys: ["evidence-a", "evidence-b"],
    });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: {
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-b"],
      },
      currentKeys: ["evidence-a"],
      openConflictPrevious: {
        sourceEvidenceConflict: "routing_or_net",
        sourceEvidenceConflictReason: "changed",
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a"],
      },
    })).toMatchObject({ kind: "restored", reason: "changed" });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: {
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a", "evidence-b"],
      },
      currentKeys: ["evidence-b"],
      openConflictPrevious: {
        sourceEvidenceConflict: "routing_or_net",
        sourceEvidenceConflictReason: "variants",
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a", "evidence-b"],
      },
    })).toMatchObject({ kind: "restored", reason: "variants" });
    expect(classifySourceEvidenceTransition({
      hasPreviousTracking: true,
      previousIdentity: null,
      currentKeys: ["evidence-d"],
      openConflictPrevious: {
        sourceEvidenceConflict: "routing_or_net",
        sourceEvidenceConflictReason: "variants",
        sourceEvidenceKeyVersion: "v2",
        sourceEvidenceKeys: ["evidence-a", "evidence-b"],
      },
    })).toMatchObject({ kind: "conflict", reason: "variants" });
  });

  it("marks routing/net evidence conflicts as non-auto-applicable", () => {
    expect(isSourceEvidenceConflict({ sourceEvidenceConflict: "routing_or_net" })).toBe(true);
    expect(isSourceEvidenceConflict({ sourceEvidenceConflict: "other" })).toBe(false);

    const consoleSource = readFileSync(resolve("src/components/sync/sync-console.tsx"), "utf8");
    expect(consoleSource).toContain("c.audited || !c.transactionId || isSourceEvidenceConflict(c)");
    expect(consoleSource).toContain("routing/net evidence — review only");
    expect(consoleSource).toContain("Pay To:");
    expect(consoleSource).toContain("Total Net Pay:");
    expect(consoleSource).toContain("Source rows:");
    expect(consoleSource).toContain("Action: restore or correct the source evidence");
    expect(consoleSource).toContain("isNewSourceEvidenceConflict");
    expect(consoleSource).toContain("New source rows disagree on routing or net evidence");
    expect(consoleSource).toContain("!isNewSourceEvidenceConflict(c)");
  });
});

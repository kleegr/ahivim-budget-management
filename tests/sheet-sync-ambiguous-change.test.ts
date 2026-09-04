import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyChangedLedgerMatch,
  classifyTrackedSourcePresence,
} from "@/lib/sheets/sync";

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
});

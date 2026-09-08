import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import * as money from "@/lib/money";
import * as reviewActions from "@/lib/nav/review-actions";
import type { SyncConflictRow } from "@/lib/sheets/queries";
import type { SourceNetRecoveryHistory } from "@/lib/sheets/net-recovery-queries";

// Compile this actual client component for SSR without changing the shared
// Next/Vitest JSX-preserve configuration or introducing another DOM runtime.
const componentSource = readFileSync("src/components/sync/net-recovery-panel.tsx", "utf8");
const compiled = transformSync(componentSource, {
  loader: "tsx", format: "cjs", jsx: "automatic", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
}).code;
const nodeRequire = createRequire(import.meta.url);
const renderedModule = { exports: {} };
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "next/link") return function TestLink({ href, children }: { href: string; children: React.ReactNode }) {
    return React.createElement("a", { href }, children);
  };
  if (name === "@/lib/money") return money;
  if (name === "@/lib/nav/review-actions") return reviewActions;
  return nodeRequire(name);
}, renderedModule, renderedModule.exports);
interface Attempt { signature: string; operationKey: string }
interface Selection { action: "accept" | "undo"; conflictId: string; acceptanceAuditId?: string }
const { default: NetRecoveryPanel, recoverableSourceNet, sourceNetRecoveryAttempt, sourceNetRecoveryHistoryHref } = renderedModule.exports as {
  default: React.ComponentType<{ conflicts: SyncConflictRow[]; history: SourceNetRecoveryHistory[] }>;
  recoverableSourceNet: (conflict: SyncConflictRow) => string | null;
  sourceNetRecoveryAttempt: (previous: Attempt | undefined, selection: Selection, reason: string, newKey: () => string) => Attempt;
  sourceNetRecoveryHistoryHref: (auditId: unknown, acceptanceAuditId: unknown) => string | null;
};

function conflict(overrides: Partial<SyncConflictRow> = {}): SyncConflictRow {
  return {
    id: "00000000-0000-4000-8000-000000000011", type: "changed", status: "open", audited: false,
    naturalKey: "synthetic-source", detail: null,
    previous: { sourceEvidenceConflict: "routing_or_net", totalNetPay: null },
    incoming: { totalNetPay: "0.0000", sourceEvidenceVariants: [{ totalNetPay: "0.0000", payTo: "EMPLOYEE" }] },
    transactionId: "00000000-0000-4000-8000-000000000012", importRowId: null, sourceFileId: null,
    individualName: "Synthetic Individual", employeeName: "Synthetic Employee", programName: "Synthetic Program",
    createdAt: "2026-09-08T00:00:00Z", ...overrides,
  };
}

function history(overrides: Partial<SourceNetRecoveryHistory> = {}): SourceNetRecoveryHistory {
  return {
    acceptanceAuditId: "00000000-0000-4000-8000-000000000021", conflictId: conflict().id,
    transactionId: conflict().transactionId!, acceptedNet: "0.0000", acceptedAt: "2026-09-08T00:00:00Z",
    acceptedBy: "Synthetic Manager", reason: "Confirmed exact source NET", reversedAt: null,
    reversalAuditId: null, ...overrides,
  };
}

describe("Source NET recovery presentation and retry safety", () => {
  it("offers explicit zero while rejecting known NET, wrong conflict types, and unresolved transactions", () => {
    expect(recoverableSourceNet(conflict())).toBe("0.0000");
    expect(recoverableSourceNet(conflict({ previous: { sourceEvidenceConflict: "routing_or_net", totalNetPay: "0.0000" } }))).toBeNull();
    expect(recoverableSourceNet(conflict({ previous: { sourceEvidenceConflict: "routing_or_net" } }))).toBeNull();
    for (const overrides of [{ type: "missing" }, { status: "dismissed" }, { transactionId: null }, { previous: {} }]) {
      expect(recoverableSourceNet(conflict(overrides))).toBeNull();
    }
  });

  it("requires one numeric source variant and does not round away a disagreement", () => {
    for (const incoming of [
      { totalNetPay: null }, { totalNetPay: "" }, { totalNetPay: "NaN" }, { totalNetPay: "Infinity" },
      { totalNetPay: "-0.0001" }, { totalNetPay: "10000000000" }, { totalNetPay: "10000000000.0001" },
      { totalNetPay: "100.12345" },
      { totalNetPay: "100.1234", sourceEvidenceVariants: [{ totalNetPay: "100.12341" }] },
      { totalNetPay: "100", sourceEvidenceVariants: [{ totalNetPay: "100" }, { totalNetPay: "101" }] },
      { totalNetPay: "100", sourceEvidenceVariants: [{ totalNetPay: null }] },
    ]) expect(recoverableSourceNet(conflict({ incoming }))).toBeNull();
    expect(recoverableSourceNet(conflict({ incoming: { totalNetPay: "100.1234" } }))).toBe("100.1234");
  });

  it("reuses an uncertain attempt key for an unchanged request and separates edits, targets, accept and undo", () => {
    const uuid = vi.fn().mockReturnValueOnce("attempt-1").mockReturnValueOnce("attempt-2").mockReturnValue("attempt-3");
    const selection = { action: "accept" as const, conflictId: "conflict-1" };
    const first = sourceNetRecoveryAttempt(undefined, selection, "Exact Sheet value", uuid);
    expect(sourceNetRecoveryAttempt(first, selection, " Exact Sheet value ", uuid)).toBe(first);
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(sourceNetRecoveryAttempt(first, selection, "Changed reason", uuid).operationKey).toBe("attempt-2");
    expect(sourceNetRecoveryAttempt(first, { ...selection, conflictId: "conflict-2" }, "Exact Sheet value", uuid).signature).not.toBe(first.signature);
    const undo = sourceNetRecoveryAttempt(first, { action: "undo", conflictId: "conflict-1", acceptanceAuditId: "audit-1" }, "Exact Sheet value", uuid);
    expect(undo.signature).not.toBe(first.signature);
    expect(sourceNetRecoveryAttempt(undo, { action: "undo", conflictId: "conflict-1", acceptanceAuditId: "audit-2" }, "Exact Sheet value", uuid).signature).not.toBe(undo.signature);
  });

  it("reloads accept and Undo through their exact audit IDs into the same saved history entry", () => {
    const accepted = history().acceptanceAuditId;
    const reversed = "00000000-0000-4000-8000-000000000022";
    expect(sourceNetRecoveryHistoryHref(accepted, accepted)).toBe(`/sync?sourceNetReview=${accepted}#source-net-history-${accepted}`);
    expect(sourceNetRecoveryHistoryHref(reversed, accepted)).toBe(`/sync?sourceNetReview=${reversed}#source-net-history-${accepted}`);
    expect(componentSource).toContain("window.location.assign(historyHref)");
    expect(componentSource).not.toContain("router.refresh");
    expect(componentSource).not.toContain("useRouter");
  });

  it("refuses to navigate on incomplete or malformed audit confirmation", () => {
    const accepted = history().acceptanceAuditId;
    for (const invalid of [undefined, null, 0, {}, "", "audit-id", `${accepted}#elsewhere`, ` ${accepted}`, "https://example.com"]) {
      expect(sourceNetRecoveryHistoryHref(invalid, accepted)).toBeNull();
      expect(sourceNetRecoveryHistoryHref(accepted, invalid)).toBeNull();
    }
  });

  it("renders zero, an exact transaction link, and separate check confirmation wording", () => {
    const markup = renderToStaticMarkup(React.createElement(NetRecoveryPanel, { conflicts: [conflict()], history: [] }));
    expect(markup).toContain("$0.00");
    expect(markup).toContain("Recorded NET: Unknown");
    expect(markup).toContain(conflict().transactionId!);
    expect(markup).toContain("Use source NET");
    expect(markup).toContain("Checks still need confirmation");
    expect(markup).not.toContain("verified check");
  });

  it("keeps saved and reversed history visible, with Undo only for the unreversed entry", () => {
    const markup = renderToStaticMarkup(React.createElement(NetRecoveryPanel, {
      conflicts: [], history: [history(), history({ acceptanceAuditId: "old-audit", reversedAt: "2026-09-08T01:00:00Z", reversalAuditId: "undo-audit" })],
    }));
    expect(markup).toContain("Source NET history");
    expect(markup).toContain(`id="source-net-history-${history().acceptanceAuditId}"`);
    expect(markup.match(/>Undo<\/button>/g)).toHaveLength(1);
    expect(markup).toContain("Undone");
    expect(markup.match(/Confirmed exact source NET/g)).toHaveLength(2);
    expect(markup.match(/\$0\.00/g)).toHaveLength(2);
  });

  it("renders nothing for unsupported conflicts without recovery history", () => {
    expect(renderToStaticMarkup(React.createElement(NetRecoveryPanel, { conflicts: [conflict({ transactionId: null })], history: [] }))).toBe("");
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  requireUser: vi.fn(), withDb: vi.fn(), getSyncConfig: vi.fn(), getSyncStatus: vi.fn(),
  listSyncRuns: vi.fn(), listOpenConflicts: vi.fn(), listSourceNetRecoveryHistory: vi.fn(),
  googleSheetsReadCredentials: vi.fn(), refreshSettlementObligations: vi.fn(), panel: vi.fn(),
};
const pool = { query: vi.fn(), connect: vi.fn() };
const compiled = transformSync(readFileSync("src/app/(app)/sync/page.tsx", "utf8"), {
  loader: "tsx", format: "cjs", jsx: "automatic", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
}).code;
const nodeRequire = createRequire(import.meta.url);
const loaded = { exports: {} };
function EmptyComponent() { return null; }
function RecoveryPanel(props: unknown) { mocks.panel(props); return null; }
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "@/lib/auth/session") return { requireUser: mocks.requireUser };
  if (name === "@/lib/data/pool") return { withDb: mocks.withDb };
  if (name === "@/lib/sheets/config") return {
    getSyncConfig: mocks.getSyncConfig, sheetSourceUrl: () => "https://example.test/source", authoritativeSheetExportUrl: () => null,
  };
  if (name === "@/lib/sheets/queries") return {
    getSyncStatus: mocks.getSyncStatus, listSyncRuns: mocks.listSyncRuns, listOpenConflicts: mocks.listOpenConflicts,
  };
  if (name === "@/lib/sheets/net-recovery-queries") return { listSourceNetRecoveryHistory: mocks.listSourceNetRecoveryHistory };
  if (name === "@/lib/sheets/google-auth") return { googleSheetsReadCredentials: mocks.googleSheetsReadCredentials };
  if (name === "@/lib/manage/settlements") return { refreshSettlementObligations: mocks.refreshSettlementObligations };
  if (name === "@/components/ui") return { PageHeader: EmptyComponent, ErrorPanel: EmptyComponent };
  if (name === "@/components/sync/sync-console") return EmptyComponent;
  if (name === "@/components/sync/net-recovery-panel") return RecoveryPanel;
  return nodeRequire(name);
}, loaded, loaded.exports);
const SyncPage = (loaded.exports as { default: () => Promise<React.ReactNode> }).default;

describe("Source NET recovery page authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "effective-manager", actorId: "signed-in-actor", role: "manager" });
    mocks.withDb.mockImplementation(async (read: (connection: typeof pool) => Promise<unknown>) => ({ ok: true, data: await read(pool) }));
    mocks.getSyncConfig.mockResolvedValue({});
    mocks.getSyncStatus.mockResolvedValue({});
    mocks.listSyncRuns.mockResolvedValue([]);
    mocks.listOpenConflicts.mockResolvedValue([{ id: "conflict-1", incoming: { totalNetPay: "0.0000" } }]);
    mocks.listSourceNetRecoveryHistory.mockResolvedValue([{ acceptanceAuditId: "audit-1", acceptedNet: "0.0000", reversedAt: null }]);
    mocks.googleSheetsReadCredentials.mockReturnValue(null);
  });

  it.each(["signed out", "budget planner", "money collector", "viewer", "custom restricted access", "owner signed in as restricted target"])(
    "stops on the session redirect for %s before reading money or source credentials", async () => {
      const denied = new Error("Synthetic session redirect");
      mocks.requireUser.mockRejectedValue(denied);
      await expect(SyncPage()).rejects.toBe(denied);
      expect(mocks.requireUser).toHaveBeenCalledExactlyOnceWith("manager");
      for (const name of ["withDb", "getSyncConfig", "getSyncStatus", "listSyncRuns", "listOpenConflicts", "listSourceNetRecoveryHistory", "googleSheetsReadCredentials", "panel", "refreshSettlementObligations"] as const) {
        expect(mocks[name]).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["manager", "admin"])("shows allowed %s the guarded history without a settlement refresh", async role => {
    mocks.requireUser.mockResolvedValue({ id: "effective-user", actorId: "signed-in-actor", role });
    renderToStaticMarkup(await SyncPage());
    expect(mocks.requireUser).toHaveBeenCalledExactlyOnceWith("manager");
    expect(mocks.requireUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.withDb.mock.invocationCallOrder[0]);
    expect(mocks.listSourceNetRecoveryHistory).toHaveBeenCalledExactlyOnceWith(pool);
    expect(mocks.panel).toHaveBeenCalledExactlyOnceWith({
      conflicts: [{ id: "conflict-1", incoming: { totalNetPay: "0.0000" } }],
      history: [{ acceptanceAuditId: "audit-1", acceptedNet: "0.0000", reversedAt: null }],
    });
    expect(mocks.refreshSettlementObligations).not.toHaveBeenCalled();
  });

  it("does not render a money panel when the read fails", async () => {
    mocks.withDb.mockResolvedValue({ ok: false, error: "Synthetic database unavailable" });
    renderToStaticMarkup(await SyncPage());
    expect(mocks.panel).not.toHaveBeenCalled();
    expect(mocks.googleSheetsReadCredentials).not.toHaveBeenCalled();
  });
});

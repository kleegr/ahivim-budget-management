import { describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import {
  getSettlementLedgerFreshness,
  markSettlementRefreshComplete,
  settlementApplicationDate,
} from "@/lib/manage/settlement-freshness";

const certifiedRow = {
  source_version: "8",
  refreshed_version: "8",
  dirty_since: null,
  last_refreshed_at: "2026-08-24T12:00:00.000Z",
  refreshed_for_date: "2026-08-24",
  last_refresh_error: null,
};

describe("settlement clock freshness", () => {
  it("uses the same UTC calendar-date basis as rolling budget periods", () => {
    expect(settlementApplicationDate(new Date("2026-08-25T00:30:00+02:00"))).toBe("2026-08-24");
  });

  it("expires a source-current certification when the application date advances", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [certifiedRow] })),
      connect: vi.fn(),
    } as unknown as PgLikePool;

    await expect(getSettlementLedgerFreshness(pool, "2026-08-24")).resolves.toMatchObject({
      dirty: false,
      refreshedForDate: "2026-08-24",
    });
    await expect(getSettlementLedgerFreshness(pool, "2026-08-25")).resolves.toMatchObject({
      dirty: true,
      sourceVersion: "8",
      refreshedVersion: "8",
      refreshedForDate: "2026-08-24",
    });
  });

  it("records the date certified by a full refresh only", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PgLikeClient;

    await markSettlementRefreshComplete(client, false, "2026-08-24");
    expect(query).not.toHaveBeenCalled();

    await markSettlementRefreshComplete(client, true, "2026-08-24");
    expect(query).toHaveBeenCalledOnce();
    expect(calls[0]?.sql).toContain("refreshed_for_date = $1::date");
    expect(calls[0]?.params).toEqual(["2026-08-24"]);
  });
});

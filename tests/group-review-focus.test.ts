import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { listGroupCandidates } from "@/lib/manage/group-detection";

describe("group review focus", () => {
  it("narrows a transaction drilldown to its exact imported service session", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;
    const sessionId = "123e4567-e89b-12d3-a456-426614174030";

    await listGroupCandidates(pool, { sessionId });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("ss.id = $2");
    expect(query.mock.calls[0]?.[1]).toEqual([null, sessionId, 200]);
  });

  it("does not put an invalid session id into the database filter", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    await listGroupCandidates(pool, { sessionId: "not-a-session" });

    expect(query.mock.calls[0]?.[1]).toEqual([null, null, 200]);
  });
});

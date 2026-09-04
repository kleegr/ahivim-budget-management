import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { updateStrategy } from "@/lib/manage/calculation-strategies";

describe("Financial Setup archived history", () => {
  it("loads archived strategies so history remains reachable", () => {
    const page = readFileSync(resolve("src/app/(app)/calculations/page.tsx"), "utf8");
    expect(page).toContain("includeArchived: true");
  });

  it("offers an archived-history view and a restore action", () => {
    const grid = readFileSync(resolve("src/components/calculations/calculations-grid.tsx"), "utf8");
    expect(grid).toContain("Show archived history");
    expect(grid).toContain("Hide archived history");
    expect(grid).toContain('rowAction(r.id, "restore")');
    expect(grid).toContain('JSON.stringify({ status: "active" })');
    expect(grid).toContain("Restore this archived setup before editing it.");
    expect(grid).toContain('r.status === "active" && !!c.editable');
    expect(grid).toContain('const drawerRow = drawerId ? rows.find((row) => row.id === drawerId) : undefined');
    expect(grid).toContain('canManage={canManage && drawerRow?.status === "active"}');
    expect(grid).toContain('role="dialog"');
    expect(grid).toContain('aria-controls="financial-setup-panel"');
  });

  it("enforces archived history immutability in the server write path", () => {
    const service = readFileSync(resolve("src/lib/manage/calculation-strategies.ts"), "utf8");
    const statusRoute = readFileSync(resolve("src/app/api/calculation-strategies/[id]/status/route.ts"), "utf8");

    expect(service).toContain("SELECT id, status FROM calculation_strategies");
    expect(service).toContain('existing.rows[0]?.status !== "active"');
    expect(service).toContain('return fail("conflict", "Restore this archived setup before editing it.")');
    expect(statusRoute).toContain('body.status !== "active" && body.status !== "archived"');
  });

  it("keeps archived setups out of live analytics and current totals", () => {
    const service = readFileSync(resolve("src/lib/manage/calculation-strategies.ts"), "utf8");
    const grid = readFileSync(resolve("src/components/calculations/calculations-grid.tsx"), "utf8");

    expect(service).toContain('const analyticRows = rows.filter((row) => row.status === "active")');
    expect(service).toContain("attachStrategyAnalytics(pool, analyticRows");
    expect(grid).toContain('if (r.status !== "active") continue');
    expect(grid).toContain("strategies++");
  });

  it("rejects archived edits before snapshotting or updating history", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT id, status FROM calculation_strategies")) {
          return {
            rows: [{ id: "11111111-1111-4111-8111-111111111111", status: "archived" }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as unknown as PgLikePool;

    const result = await updateStrategy(pool, {
      id: "11111111-1111-4111-8111-111111111111",
      notes: "Do not rewrite archived evidence",
    }, null);

    expect(result).toEqual({
      ok: false,
      code: "conflict",
      message: "Restore this archived setup before editing it.",
    });
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.includes("calculation_strategy_revisions"))).toBe(false);
    expect(statements.some((sql) => sql.includes("UPDATE calculation_strategies"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("loads and safely edits source notes with the same revision-preserving path", () => {
    const service = readFileSync(resolve("src/lib/manage/calculation-strategies.ts"), "utf8");
    const route = readFileSync(resolve("src/app/api/calculation-strategies/[id]/route.ts"), "utf8");
    const grid = readFileSync(resolve("src/components/calculations/calculations-grid.tsx"), "utf8");

    expect(service).toContain("s.after_all::text, s.account, s.notes, s.status");
    expect(service).toContain('set("notes", input.notes?.trim() || null)');
    expect(route).toContain("body.notes !== undefined");
    expect(grid).toContain('key: "notes", label: "Notes"');
  });
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";

const mocks = vi.hoisted(() => ({ recordChange: vi.fn(), recordChanges: vi.fn() }));

vi.mock("@/lib/manage/audit", () => mocks);

import { setTransactionsPaid } from "@/lib/manage/transactions";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("read-only Google Sheet boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("contains no outbound Sheet mutation module, endpoint, or OAuth scope", () => {
    const sheetsDir = join(process.cwd(), "src", "lib", "sheets");
    expect(existsSync(join(sheetsDir, ["write", "back.ts"].join("")))).toBe(false);
    expect(existsSync(join(sheetsDir, "round-trip.ts"))).toBe(false);

    const source = sourceFiles(join(process.cwd(), "src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toContain(["values", "batchUpdate"].join(":"));
    expect(source).not.toMatch(/https:\/\/www\.googleapis\.com\/auth\/spreadsheets["']/);
    expect(source).not.toContain(["appPaid", "Dirty"].join(""));
    expect(source).not.toContain(["pushPaid", "ChangesToSheet"].join(""));
    expect(source).not.toContain(["runSheet", "RoundTrip"].join(""));
  });

  it("stores an operator Paid decision only in Neon", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const transactionId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (statement: string) => ({
      rows: statement.includes("FROM payroll_transactions")
        ? [{ id: transactionId, is_paid: false, paid_at: null, paid_note: "Prior note" }]
        : statement.includes("UPDATE payroll_transactions")
          ? [{ id: transactionId, is_paid: true, paid_at: "2026-09-09", paid_note: "Prior note" }]
          : [],
      rowCount: statement.includes("UPDATE payroll_transactions") ? 1 : 0,
    }));
    const release = vi.fn();
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as PgLikePool;

    const result = await setTransactionsPaid(
      pool,
      { ids: ["00000000-0000-4000-8000-000000000001"], paid: true },
      "00000000-0000-4000-8000-000000000002",
    );

    expect(result).toEqual({ ok: true, data: { updated: 1, batchId: expect.any(String) } });
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("sheet_sync_rows");
    expect(mocks.recordChange).toHaveBeenCalledOnce();
    expect(mocks.recordChanges).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      entityId: transactionId,
      previous: expect.objectContaining({ is_paid: false, paid_note: "Prior note" }),
      next: expect.objectContaining({ is_paid: true, paid_note: "Prior note" }),
    })]);
    expect(request).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

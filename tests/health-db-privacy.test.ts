import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  ledgerExists: vi.fn(),
  listTables: vi.fn(),
  query: vi.fn(),
  tableCounts: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ currentUser: mocks.currentUser }));
vi.mock("@/lib/db", () => ({
  getPool: () => ({ query: mocks.query }),
  resolveConnectionEnvName: () => "DATABASE_URL",
}));
vi.mock("@/lib/db/migrate", () => ({
  ledgerExists: mocks.ledgerExists,
  listTables: mocks.listTables,
  tableCounts: mocks.tableCounts,
}));

import { GET } from "@/app/api/health/db/route";

describe("database health response privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue(null);
    mocks.query.mockResolvedValue({
      rows: [{ now: "2026-09-04T22:00:00Z", version: "PostgreSQL 17.5" }],
    });
    mocks.ledgerExists.mockResolvedValue(true);
    mocks.listTables.mockResolvedValue(["users", "payroll_transactions"]);
    mocks.tableCounts.mockResolvedValue({ users: 1, payroll_transactions: 5_334 });
  });

  it("returns only connectivity and migration health anonymously", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      connected: true,
      migrationsApplied: true,
      detail: "public",
    });
    expect(mocks.listTables).not.toHaveBeenCalled();
    expect(mocks.tableCounts).not.toHaveBeenCalled();
  });

  it("keeps detailed diagnostics available to an administrator", async () => {
    mocks.currentUser.mockResolvedValue({ role: "admin" });

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      ok: true,
      detail: "administrator",
      connectionVariable: "DATABASE_URL",
      tableCount: 2,
      tables: ["users", "payroll_transactions"],
      rowCounts: { users: 1, payroll_transactions: 5_334 },
    });
  });

  it("does not return a driver error to an anonymous caller", async () => {
    mocks.query.mockRejectedValue(
      new Error("connect postgres://user:password@private-db.example.test/ahivim"),
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      connected: false,
      reason: "Database check failed.",
    });
    expect(JSON.stringify(body)).not.toContain("private-db");
    expect(JSON.stringify(body)).not.toContain("password");
  });
});

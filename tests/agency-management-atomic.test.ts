import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { setAgencyIndividualMembership } from "@/lib/manage/agencies";

const AGENCY = "00000000-0000-4000-8000-000000000010";
const INDIVIDUAL = "00000000-0000-4000-8000-000000000011";
const ACTOR = "00000000-0000-4000-8000-000000000012";

describe("agency security mutation transactions", () => {
  it("rolls back a membership write when its audit record fails", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (statement: string) => {
      statements.push(statement);
      if (statement.includes("SELECT EXISTS")) {
        return { rows: [{ agency_exists: true, person_exists: true }] };
      }
      if (statement.includes("INSERT INTO audit_logs")) throw new Error("audit unavailable");
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query } as unknown as PgLikePool;

    await expect(setAgencyIndividualMembership(pool, AGENCY, {
      individualId: INDIVIDUAL,
      managesBudget: true,
      billsServices: false,
      effectiveFrom: "2026-01-01",
    }, ACTOR)).rejects.toThrow("audit unavailable");

    expect(statements).toContain("BEGIN");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

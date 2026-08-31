import { describe, expect, it, vi } from "vitest";
import { createBudgetPeriod } from "@/lib/manage/authorizations";
import type { PgLikePool } from "@/lib/import/commit";

const PERSON = "10000000-0000-4000-8000-000000000001";
const PERIOD = "20000000-0000-4000-8000-000000000001";

function poolWithCapture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO budget_periods")) return { rows: [{ id: PERIOD }] };
    if (sql.includes("FROM budget_periods WHERE id")) {
      return {
        rows: [{
          id: PERIOD,
          individual_id: PERSON,
          label: "Annual",
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          period_type: "rolling",
          renewal_date: "2027-01-01",
          status: "active",
          source: "program_budget",
          notes: null,
        }],
      };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as PgLikePool, calls };
}

describe("canonical renewal period writes", () => {
  it("derives start and end from renewal when independent dates are omitted", async () => {
    const { pool, calls } = poolWithCapture();
    const result = await createBudgetPeriod(pool, {
      individualId: PERSON,
      label: "Annual",
      renewalDate: "2027-01-01",
      source: "program_budget",
    }, null);

    expect(result).toMatchObject({
      ok: true,
      data: { startDate: "2026-01-01", endDate: "2026-12-31", renewalDate: "2027-01-01" },
    });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO budget_periods"));
    expect(insert?.params.slice(2, 6)).toEqual([
      "2026-01-01",
      "2026-12-31",
      "rolling",
      "2027-01-01",
    ]);
  });

  it("rejects dates that conflict with the renewal-derived period", async () => {
    const query = vi.fn();
    const result = await createBudgetPeriod({ query } as unknown as PgLikePool, {
      individualId: PERSON,
      label: "Annual",
      startDate: "2026-01-01",
      endDate: "2027-01-01",
      renewalDate: "2027-01-01",
    }, null);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(query).not.toHaveBeenCalled();
  });
});

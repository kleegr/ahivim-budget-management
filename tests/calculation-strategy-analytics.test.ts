import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { listStrategies } from "@/lib/manage/calculation-strategies";

const STRATEGY_ID = "00000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000002";
const DAY_HAB_ID = "00000000-0000-4000-8000-000000000003";
const COM_HAB_ID = "00000000-0000-4000-8000-000000000004";

describe("strategy actual-vs-plan analytics", () => {
  it("derives group-day hours from internal dollars at the strategy rate", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("FROM calculation_strategies s")) {
        return {
          rows: [{
            id: STRATEGY_ID,
            individual_id: INDIVIDUAL_ID,
            individual_name: "Ari Test",
            individual_status: "active",
            label: "1",
            renewal_date: "2027-01-01",
            month_divisor: "12",
            cut1_percent: "0",
            cut2_percent: "0",
            clock_adjustment: "0",
            other_adjustment: "0",
            after_all: null,
            account: null,
            status: "active",
            sort_order: 0,
            revision_count: "0",
          }],
        };
      }
      if (sql.includes("FROM calculation_strategy_lines")) {
        return {
          rows: [
            { strategy_id: STRATEGY_ID, program_id: DAY_HAB_ID, authorized_hours: "100", rate_override: null, rate_override_effective_from: null },
            { strategy_id: STRATEGY_ID, program_id: COM_HAB_ID, authorized_hours: "20", rate_override: null, rate_override_effective_from: null },
          ],
        };
      }
      if (sql.includes("FROM program_rate_schedules")) {
        return {
          rows: [
            { program_id: DAY_HAB_ID, internal_rate: "17", effective_from: "2020-01-01" },
            { program_id: COM_HAB_ID, internal_rate: "21", effective_from: "2020-01-01" },
          ],
        };
      }
      if (sql.includes("FROM programs p")) {
        return {
          rows: [
            { id: DAY_HAB_ID, code: "DAY_HAB", name: "Day Hab", as_of: "2026-08-24" },
            { id: COM_HAB_ID, code: "COM_HAB", name: "Community Hab", as_of: "2026-08-24" },
          ],
        };
      }
      if (sql.includes("WITH win AS")) {
        return {
          rows: [
            { individual_id: INDIVIDUAL_ID, program_id: DAY_HAB_ID, program_code: "DAY_HAB", hours: "30", internal: "170", observations: "2" },
            { individual_id: INDIVIDUAL_ID, program_id: COM_HAB_ID, program_code: "COM_HAB", hours: "5", internal: "105", observations: "1" },
          ],
        };
      }
      if (sql.includes("FROM scheduled_allocations")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const result = await listStrategies(pool, { withAnalytics: true, asOf: "2026-08-24" });

    expect(result.rows[0]?.analytics).toMatchObject({
      plannedHours: "120.0000",
      actualHours: "15.0000",
      actualInternal: "275.0000",
      utilizationPercent: "0.125",
    });
    const billedCall = calls.find(({ sql }) => sql.includes("WITH win AS"));
    expect(billedCall?.params?.[4]).toBe("2026-08-24");
  });
});

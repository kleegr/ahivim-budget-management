import { describe, expect, it, vi } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import { getIndividualPortfolioStaffingContext } from "@/lib/data/individual-profile";
import type { PgLikePool } from "@/lib/import/commit";

const INDIVIDUAL_A = "10000000-0000-4000-8000-000000000001";
const INDIVIDUAL_B = "10000000-0000-4000-8000-000000000002";
const EMPLOYEE_A = "20000000-0000-4000-8000-000000000001";
const EMPLOYEE_B = "20000000-0000-4000-8000-000000000002";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";

describe("individual portfolio staffing context", () => {
  it("reuses current assignments and the first canonical upcoming session", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM assignments a")) {
        return {
          rows: [
            {
              id: "40000000-0000-4000-8000-000000000001",
              employee_id: EMPLOYEE_B,
              employee_name: "Zev Worker",
              individual_id: INDIVIDUAL_A,
              individual_name: "Ari Person",
              program_id: null,
              program_name: null,
              start_date: null,
              end_date: null,
              allowed_hours: null,
              status: "active",
              notes: null,
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              id: "40000000-0000-4000-8000-000000000002",
              employee_id: EMPLOYEE_A,
              employee_name: "Abe Worker",
              individual_id: INDIVIDUAL_A,
              individual_name: "Ari Person",
              program_id: null,
              program_name: null,
              start_date: "2026-01-01",
              end_date: "2026-12-31",
              allowed_hours: null,
              status: "active",
              notes: null,
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              id: "40000000-0000-4000-8000-000000000003",
              employee_id: EMPLOYEE_A,
              employee_name: "Abe Worker",
              individual_id: INDIVIDUAL_B,
              individual_name: "Ben Person",
              program_id: null,
              program_name: null,
              start_date: null,
              end_date: "2026-08-31",
              allowed_hours: null,
              status: "active",
              notes: null,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      if (sql.includes("FROM scheduled_sessions s")) {
        return {
          rows: [{
            id: SESSION_ID,
            series_id: null,
            session_date: "2026-09-08",
            start_time: "09:00",
            end_time: "11:00",
            duration_hours: "2",
            employee_id: EMPLOYEE_A,
            employee_name: "Abe Worker",
            program_id: "50000000-0000-4000-8000-000000000001",
            program_name: "Community Habilitation",
            is_group: true,
            group_size: 2,
            status: "pending",
            warnings: [],
            can_change_schedule: true,
            individual_names: ["Ari Person", "Ben Person"],
            individual_ids: [INDIVIDUAL_A, INDIVIDUAL_B],
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = { query } as unknown as PgLikePool;

    const context = await getIndividualPortfolioStaffingContext(
      pool,
      fullAccess("admin-1", "admin"),
      { canViewPlanning: true, from: "2026-09-04" },
    );

    expect(context.get(INDIVIDUAL_A)?.assignedEmployees).toEqual([
      { id: EMPLOYEE_A, name: "Abe Worker" },
      { id: EMPLOYEE_B, name: "Zev Worker" },
    ]);
    expect(context.get(INDIVIDUAL_B)?.assignedEmployees).toEqual([]);
    expect(context.get(INDIVIDUAL_A)?.nextSession?.id).toBe(SESSION_ID);
    expect(context.get(INDIVIDUAL_B)?.nextSession?.id).toBe(SESSION_ID);
  });

  it("does not query employee or schedule facts for a restricted profile", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as PgLikePool;

    const context = await getIndividualPortfolioStaffingContext(
      pool,
      fullAccess("admin-1", "admin"),
      { canViewPlanning: false, from: "2026-09-04" },
    );

    expect(context.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

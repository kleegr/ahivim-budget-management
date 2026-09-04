import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { createAssignment, updateAssignment } from "@/lib/manage/assignments";

const ASSIGNMENT_ID = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000003";

describe("assignment effective-date validation", () => {
  it("rejects a non-calendar start date before opening a transaction", async () => {
    const pool = { connect: vi.fn() } as unknown as PgLikePool;

    await expect(createAssignment(pool, {
      employeeId: EMPLOYEE_ID,
      individualId: INDIVIDUAL_ID,
      startDate: "2026-02-29",
    }, null)).resolves.toEqual({
      ok: false,
      code: "validation",
      message: "Use real assignment dates in YYYY-MM-DD form.",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a non-calendar end date before loading the existing assignment", async () => {
    const pool = { connect: vi.fn() } as unknown as PgLikePool;

    await expect(updateAssignment(pool, ASSIGNMENT_ID, {
      endDate: "2026-13-01",
    }, null)).resolves.toEqual({
      ok: false,
      code: "validation",
      message: "Use real assignment dates in YYYY-MM-DD form.",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

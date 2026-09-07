import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  resolveSchedulePaymentRecipient,
  resolveSchedulePaymentRecipients,
} from "@/lib/data/schedule-payment-routing";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "20000000-0000-4000-8000-000000000001";

describe("schedule payment routing", () => {
  it("uses current Program configuration without consulting actual transactions", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [
        { on_date: "2026-09-07", payment_recipient: "excellent_staffing" },
        { on_date: "2026-09-14", payment_recipient: "excellent_staffing" },
      ],
    }));
    const pool = { query } as unknown as PgLikePool;

    const routes = await resolveSchedulePaymentRecipients(pool, {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      onDates: ["2026-09-14", "2026-09-07", "2026-09-07"],
    });

    expect(routes).toEqual(new Map([
      ["2026-09-07", "excellent_staffing"],
      ["2026-09-14", "excellent_staffing"],
    ]));
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("effective_payment_recipient(");
    expect(sql).toContain("NULL::text, program.payment_recipient");
    expect(sql).not.toContain("payroll_transactions");
    expect(sql).not.toContain("canonical_service_date(");
    expect(params).toEqual([
      PROGRAM_ID,
      ["2026-09-07", "2026-09-14"],
    ]);
  });

  it("normalizes missing or unsupported routing to unknown", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ on_date: "2026-09-07", payment_recipient: "agency" }],
    }));
    const pool = { query } as unknown as PgLikePool;

    await expect(resolveSchedulePaymentRecipient(pool, {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      onDate: "2026-09-07",
    })).resolves.toBe("unknown");
  });

  it("fails closed before querying invalid subjects or dates", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as PgLikePool;

    await expect(resolveSchedulePaymentRecipient(pool, {
      employeeId: "bad",
      programId: PROGRAM_ID,
      onDate: "2026-02-29",
    })).resolves.toBe("unknown");
    expect(query).not.toHaveBeenCalled();
  });
});

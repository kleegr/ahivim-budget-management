import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  getEmployeeMonthlyPayments,
  getEmployeeSchedule,
} from "@/lib/data/employee-queries";
import type { PgLikePool } from "@/lib/import/commit";
import { dec } from "@/lib/money";

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";
const page = readFileSync("src/app/(app)/employees/[id]/page.tsx", "utf8");
const availability = readFileSync("src/components/schedule/employee-availability-manager.tsx", "utf8");

describe("Employee Profile current-state facts", () => {
  it("limits the upcoming schedule headline and list to future pending sessions", async () => {
    const statements: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("AS pending_sessions")) {
          return {
            rows: [{
              pending_sessions: "2",
              pending_hours: "4.5",
              completed_sessions: "1",
              completed_hours: "2",
              cancelled_sessions: "0",
              no_show_sessions: "0",
            }],
          };
        }
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    const result = await getEmployeeSchedule(pool, EMPLOYEE_ID);
    expect(result.summary).toMatchObject({ pendingSessions: 2, pendingHours: "4.5000" });
    expect(statements).toHaveLength(2);
    expect(statements.every((sql) => sql.includes("s.session_date >= CURRENT_DATE"))).toBe(true);
  });

  it("returns an explicit unknown monthly route and makes route bases reconcile", async () => {
    let statement = "";
    const pool = {
      query: vi.fn(async (sql: string) => {
        statement = sql;
        return {
          rows: [{
            month: "2026-08",
            agency_gross: "125",
            internal_amount: "100",
            total_payment: "90",
            paid_to_employee: "60",
            payable_by_agency: "30",
            unknown_recipient: "10",
            check_count: "2",
            transaction_count: "3",
          }],
        };
      }),
    } as unknown as PgLikePool;

    const [month] = await getEmployeeMonthlyPayments(pool, EMPLOYEE_ID);
    expect(month).toMatchObject({
      internalAmount: "100.0000",
      paidToEmployee: "60.0000",
      payableByAgency: "30.0000",
      unknownRecipient: "10.0000",
    });
    expect(dec(month!.paidToEmployee).plus(month!.payableByAgency).plus(month!.unknownRecipient).eq(month!.internalAmount)).toBe(true);
    expect(statement.match(/sum\(t\.calculated_internal_amount\)/g)).toHaveLength(4);
    expect(statement).toContain("AS unknown_recipient");
    expect(page).toContain("Unknown route");
    expect(page).not.toContain("attributionAvailable");
  });

  it("does not render true-empty availability states after the availability query fails", () => {
    expect(availability).toContain("const [loadError, setLoadError]");
    expect(availability).toContain("setLoadError(result.error ?? \"Could not load employee hours.\")");
    expect(availability).toContain("loadError ? null :");
    expect(availability).toContain(">Try again</button>");
  });
});

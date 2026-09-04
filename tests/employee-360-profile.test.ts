import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  listEmployeeProfileChecks,
  listEmployeeProfilePreviewAccounts,
  normalizeEmployeeProfileView,
  summarizeEmployeeMoneyRoots,
  type EmployeeMoneyRoot,
} from "@/lib/data/employee-profile";

const page = readFileSync("src/app/(app)/employees/[id]/page.tsx", "utf8");
const employeeId = "00000000-0000-4000-8000-000000000001";

function root(overrides: Partial<EmployeeMoneyRoot>): EmployeeMoneyRoot {
  return {
    id: "root",
    flow: "direct_employee",
    direction: "receivable",
    target: "100.00",
    applied: "40.00",
    balance: "60.00",
    state: "partial",
    checkNumber: null,
    serviceDate: null,
    ...overrides,
  };
}

describe("Employee 360 profile", () => {
  it("ships one stable five-tab profile and preserves legacy links", () => {
    for (const label of ["Overview", "Actual Activity", "Staffing", "Money", "More"]) {
      expect(page).toContain(`label: "${label}"`);
    }
    expect(normalizeEmployeeProfileView("people")).toBe("activity");
    expect(normalizeEmployeeProfileView("checks")).toBe("money");
    expect(normalizeEmployeeProfileView("deal")).toBe("money");
    expect(normalizeEmployeeProfileView("details")).toBe("more");
    expect(normalizeEmployeeProfileView("unknown")).toBe("overview");
  });

  it("keeps actual work separate from authorized planning data", () => {
    expect(page).toContain("Actual, recorded activity");
    expect(page).toContain("Future pending sessions only; actual work remains in Actual Activity.");
    expect(page).toContain("canPlanProfile ? getEmployeeSchedule");
    expect(page).toContain("EmployeeAvailabilityManager");
    expect(page).toContain("Current assignments");
    expect(page).toContain("Weekly hours and time off");
  });

  it("uses actual linked accounts for contextual Owner preview", () => {
    expect(page).toContain('user.role === "admin"');
    expect(page).toContain('action="/api/auth/impersonation/start"');
    expect(page).toContain('name="targetUserId"');
    expect(page).toContain("Preview Employee portal");
  });

  it("does not collapse Direct-Pay and Agency-Routed money semantics", () => {
    for (const phrase of [
      "Direct-Pay",
      "Agency-Routed",
      "not proof the check was issued, received, or cleared",
      "not proof the Agency paid the Employee",
      "Canonical payroll checks",
      "actual payroll-check net",
    ]) {
      expect(page).toContain(phrase);
    }
    expect(page).toContain('recipient: "employee"');
    expect(page).toContain('recipient: "excellent_staffing"');
  });
});

describe("Employee route-specific money summaries", () => {
  const rows = [
    root({ id: "direct-open" }),
    root({ id: "direct-credit", target: "25.00", applied: "30.00", balance: "-5.00", state: "credit" }),
    root({ id: "agency-open", flow: "agency_routed", direction: "payable", target: "80.00", applied: "50.00", balance: "30.00" }),
    root({ id: "agency-reversal", flow: "agency_routed", direction: "receivable", target: "7.00", applied: "0.00", balance: "7.00", state: "open" }),
  ];

  it("summarizes Direct-Pay give-back independently", () => {
    expect(summarizeEmployeeMoneyRoots(rows, "direct_employee")).toEqual({
      due: "125.0000",
      paid: "70.0000",
      credit: "5.0000",
      remaining: "60.0000",
      openItems: 1,
    });
  });

  it("summarizes Agency-Routed payouts and opposite-direction credit independently", () => {
    expect(summarizeEmployeeMoneyRoots(rows, "agency_routed")).toEqual({
      due: "80.0000",
      paid: "50.0000",
      credit: "7.0000",
      remaining: "30.0000",
      openItems: 2,
    });
  });
});

describe("Employee profile source facts", () => {
  it("finds only active Employee self-service accounts", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{
        user_id: "00000000-0000-4000-8000-000000000099",
        display_name: "Employee Account",
        email: "employee@example.com",
        last_login_at: "2026-09-01T12:00:00Z",
      }],
    }));
    const accounts = await listEmployeeProfilePreviewAccounts({ query } as unknown as PgLikePool, employeeId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.email).toBe("employee@example.com");
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("relationship.relationship_type = 'self'");
    expect(sql).toContain("portal_role.portal_role = 'employee'");
    expect(sql).toContain("portal_role.is_active = true");
    expect(sql).toContain("account.is_active = true");
  });

  it("redacts each canonical check field independently", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{
        id: "00000000-0000-4000-8000-000000000010",
        check_number: "CHK-10",
        check_date: "2026-08-31",
        period_begin: "2026-08-01",
        period_end: "2026-08-31",
        actual_gross: "1000.00",
        actual_net: "800.00",
        tax_withheld: "200.00",
        verification_status: "verified" as const,
        linked_transactions: "3",
        transaction_ids: ["transaction"],
      }],
    }));
    const checks = await listEmployeeProfileChecks(
      { query } as unknown as PgLikePool,
      employeeId,
      { gross: false, net: true, tax: false, transactions: false },
    );
    expect(checks[0]).toMatchObject({
      actualGross: null,
      actualNet: "800.0000",
      taxWithheld: null,
      linkedTransactions: 3,
      transactionIds: [],
    });
  });
});

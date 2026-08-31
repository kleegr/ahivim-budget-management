import { describe, expect, it } from "vitest";
import {
  checkGroupIdentity,
  groupChecks,
} from "@/components/transactions/check-grouping";
import type { GridTransaction } from "@/lib/data/transactions-grid";

function transaction(overrides: Partial<GridTransaction> = {}): GridTransaction {
  return {
    id: "row-1",
    payTo: null,
    checkDate: "2026-01-15",
    checkNumber: "CHK-100",
    hours: "1.00",
    rate: "25.00",
    gross: "25.00",
    totalNetPay: "21.00",
    periodBegin: "2026-01-01",
    periodEnd: "2026-01-14",
    program: "Community Habilitation",
    programCode: "COMHAB",
    programId: null,
    individual: "Test Individual",
    individualId: "individual-1",
    employee: "Test Employee",
    employeeId: "employee-1",
    internalAmount: "21.00",
    agencyAdditional: "4.00",
    paymentRecipient: "employee",
    importBatchId: null,
    importRowId: null,
    sourceFileId: null,
    matchStatus: "new",
    isGroup: false,
    serviceSessionId: null,
    isPaid: false,
    paidAt: null,
    paidNote: null,
    ...overrides,
  };
}

describe("billed activity check grouping", () => {
  it("separates a reused check number by check date", () => {
    const checks = groupChecks([
      transaction({ id: "row-1" }),
      transaction({ id: "row-2" }),
      transaction({ id: "row-3", checkDate: "2026-02-15", periodBegin: "2026-02-01", periodEnd: "2026-02-14" }),
    ]);

    expect(checks).toHaveLength(2);
    expect(checks.map((check) => [check.checkDate, check.rows])).toEqual([
      ["2026-02-15", 1],
      ["2026-01-15", 2],
    ]);
  });

  it("falls back to pay period when a numbered check has no check date", () => {
    const first = transaction({ checkDate: null });
    const second = transaction({
      id: "row-2",
      checkDate: null,
      periodBegin: "2026-01-15",
      periodEnd: "2026-01-31",
    });

    expect(checkGroupIdentity(first)).toContain("period:2026-01-01:2026-01-14");
    expect(checkGroupIdentity(second)).toContain("period:2026-01-15:2026-01-31");
    expect(groupChecks([first, second])).toHaveLength(2);
  });

  it("normalizes surrounding check-number whitespace within the same dated check", () => {
    const first = transaction({ checkNumber: " CHK-100 " });
    const second = transaction({ id: "row-2", checkNumber: "CHK-100" });

    expect(checkGroupIdentity(first)).toBe(checkGroupIdentity(second));
    expect(groupChecks([first, second])).toMatchObject([{ checkNumber: "CHK-100", rows: 2 }]);
  });

  it("groups an agency payment by its payee across multiple employees", () => {
    const checks = groupChecks([
      transaction({ id: "row-1", payTo: "Excellent Staffing", employee: "First Employee", employeeId: "employee-1" }),
      transaction({ id: "row-2", payTo: "Excellent Staffing", employee: "Second Employee", employeeId: "employee-2" }),
    ]);

    expect(checks).toMatchObject([{
      rows: 2,
      payTo: "Excellent Staffing",
      employee: "Multiple employees",
      employeeId: null,
      transactionIds: ["row-1", "row-2"],
    }]);
  });
});

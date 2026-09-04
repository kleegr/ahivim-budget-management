import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkGroupIdentity,
  groupChecks,
} from "@/components/transactions/check-grouping";
import type { GridTransaction } from "@/lib/data/transactions-grid";

const transactionGridSource = readFileSync(
  resolve("src/components/transactions/transactions-grid.tsx"),
  "utf8",
);

function transactionColumns(): Array<{ key: string; label: string; hidden: boolean }> {
  const start = transactionGridSource.indexOf("const COLUMNS:");
  const end = transactionGridSource.indexOf("\n];", start);
  const block = transactionGridSource.slice(start, end);
  const matches = [...block.matchAll(/\bkey: "([^"]+)"/g)];
  return matches.map((match, index) => {
    const next = matches[index + 1]?.index ?? block.length;
    const definition = block.slice(match.index, next);
    return {
      key: match[1]!,
      label: definition.match(/\blabel: "([^"]+)"/)?.[1] ?? "",
      hidden: /\bhidden: true\b/.test(definition),
    };
  });
}

function transaction(overrides: Partial<GridTransaction> = {}): GridTransaction {
  return {
    id: "row-1",
    serviceDate: "2026-01-01",
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
    programId: "program-1",
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
    groupDetectionStatus: "single",
    isPaid: false,
    paidAt: null,
    paidNote: null,
    ...overrides,
  };
}

describe("billed activity check grouping", () => {
  it("starts row mode with the brief's simple transaction columns", () => {
    const visible = transactionColumns()
      .filter((column) => !column.hidden)
      .map((column) => [column.key, column.label]);

    expect(visible).toEqual([
      ["serviceDate", "Service date"],
      ["checkDate", "Check date"],
      ["individual", "Individual"],
      ["employee", "Employee"],
      ["program", "Program"],
      ["hours", "Hours"],
      ["gross", "Funder billed"],
      ["internalAmount", "Employee base"],
      ["agencyAdditional", "Agency spread"],
      ["paymentRecipient", "Payment recipient"],
      ["nextStep", "Next step"],
    ]);
  });

  it("keeps advanced source, calculation and audit fields in the column chooser", () => {
    const hidden = transactionColumns().filter((column) => column.hidden).map((column) => column.key);
    expect(hidden).toEqual(expect.arrayContaining([
      "payTo",
      "checkNumber",
      "rate",
      "totalNetPay",
      "paid",
      "periodBegin",
      "periodEnd",
      "matchStatus",
      "groupStatus",
      "sourceName",
      "sourceSheet",
      "sourceRowNumber",
    ]));
  });

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

  it("puts payroll checks needing a decision before ready checks", () => {
    const checks = groupChecks([
      transaction({ id: "ready", checkNumber: "CHK-READY", totalNetPay: "20.00" }),
      transaction({ id: "review", checkNumber: "CHK-REVIEW", paymentRecipient: "unknown" }),
    ]);

    expect(checks.map((check) => check.checkNumber)).toEqual(["CHK-REVIEW", "CHK-READY"]);
    expect(checks[0]).toMatchObject({ needsReview: true });
    expect(checks[0]?.reviewReasons).toContain("Confirm recipient");
    expect(checks[1]).toMatchObject({ needsReview: false, reviewReasons: [] });
  });

  it("uses the populated check net once and flags conflicting source values", () => {
    const checks = groupChecks([
      transaction({ id: "row-1", totalNetPay: null }),
      transaction({ id: "row-2", totalNetPay: "21.00" }),
      transaction({ id: "row-3", totalNetPay: "22.00" }),
    ]);

    expect(checks).toMatchObject([{
      netPay: "21.00",
      needsReview: true,
      reviewReasons: expect.arrayContaining(["Check net values differ"]),
    }]);
  });

  it("opens check evidence with a short stable filter instead of every row id", () => {
    const source = readFileSync(resolve("src/components/transactions/billed-activity-workspace.tsx"), "utf8");

    expect(source).toContain('params.set("checkNumber", check.checkNumber)');
    expect(source).toContain('params.set("payToKey", check.payTo.trim().toLocaleLowerCase())');
    expect(source).toContain('params.set("checkDateFrom", check.checkDate)');
    expect(source).toContain('params.set("pbFrom", check.periodBegin)');
    expect(source).not.toContain('params.append("transactionId"');
  });
});

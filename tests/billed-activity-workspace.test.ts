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
    employeeRate: "21.00",
    gross: "25.00",
    totalNetPay: "21.00",
    verifiedCheckGross: "25.00",
    verifiedCheckNet: "21.00",
    withholding: "4.00",
    verificationStatus: "verified",
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
  it("starts row mode with the takeover's complete transaction columns", () => {
    const visible = transactionColumns()
      .filter((column) => !column.hidden)
      .map((column) => [column.key, column.label]);

    expect(visible).toEqual([
      ["payTo", "Pay to"],
      ["checkDate", "Check date"],
      ["checkNumber", "Check #"],
      ["serviceDate", "Service date"],
      ["periodBegin", "Period begin"],
      ["periodEnd", "Period end"],
      ["programCode", "Code"],
      ["program", "Program"],
      ["individual", "Individual"],
      ["employee", "Employee"],
      ["hours", "Hours"],
      ["rate", "Funder rate"],
      ["gross", "Funder billed"],
      ["employeeRate", "Employee rate"],
      ["internalAmount", "Employee base"],
      ["agencyAdditional", "Agency spread"],
      ["verifiedCheckGross", "Verified check gross"],
      ["verifiedCheckNet", "Verified check net"],
      ["withholding", "Withholding"],
      ["verificationStatus", "Check status"],
      ["paid", "Paid"],
      ["paymentRecipient", "Payment recipient"],
      ["nextStep", "Review status"],
    ]);
  });

  it("keeps advanced source, calculation and audit fields in the column chooser", () => {
    const hidden = transactionColumns().filter((column) => column.hidden).map((column) => column.key);
    expect(hidden).toEqual(expect.arrayContaining([
      "totalNetPay",
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

  it("keeps all period bounds in identity even when check date is populated", () => {
    const checks = groupChecks([
      transaction({ id: "row-1" }),
      transaction({ id: "row-2", periodBegin: "2026-01-02" }),
      transaction({ id: "row-3", periodEnd: "2026-01-15" }),
    ]);

    expect(checks).toHaveLength(3);
  });

  it("falls back to pay period when a numbered check has no check date", () => {
    const first = transaction({ checkDate: null });
    const second = transaction({
      id: "row-2",
      checkDate: null,
      periodBegin: "2026-01-15",
      periodEnd: "2026-01-31",
    });

    expect(checkGroupIdentity(first)).not.toBe(checkGroupIdentity(second));
    expect(groupChecks([first, second])).toHaveLength(2);
  });

  it("excludes a row with no usable check identity from Check mode", () => {
    const unidentified = transaction({
      checkNumber: null,
      checkDate: null,
      periodBegin: null,
      periodEnd: null,
    });

    expect(checkGroupIdentity(unidentified)).toBeNull();
    expect(groupChecks([unidentified])).toEqual([]);
  });

  it("normalizes surrounding check-number whitespace within the same dated check", () => {
    const first = transaction({ checkNumber: " CHK-100 " });
    const second = transaction({ id: "row-2", checkNumber: "CHK-100" });

    expect(checkGroupIdentity(first)).toBe(checkGroupIdentity(second));
    expect(groupChecks([first, second])).toMatchObject([{ checkNumber: "CHK-100", rows: 2 }]);
  });

  it("does not collapse agency-routed rows across employees", () => {
    const checks = groupChecks([
      transaction({ id: "row-1", payTo: "Excellent Staffing", employee: "First Employee", employeeId: "employee-1" }),
      transaction({ id: "row-2", payTo: "Excellent Staffing", employee: "Second Employee", employeeId: "employee-2" }),
    ]);

    expect(checks).toHaveLength(2);
    expect(checks.map((check) => check.employeeId).sort()).toEqual(["employee-1", "employee-2"]);
    expect(checks.every((check) => check.rows === 1)).toBe(true);
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

  it("projects verified check facts once on the complete-identity summary", () => {
    const checks = groupChecks([
      transaction({ id: "row-1" }),
      transaction({ id: "row-2" }),
    ]);

    expect(checks).toMatchObject([{
      rows: 2,
      verifiedCheckGross: "25.00",
      verifiedCheckNet: "21.00",
      withholding: "4.00",
      verificationStatus: "verified",
    }]);
  });

  it("preserves zero-valued verified check facts as present values", () => {
    const checks = groupChecks([
      transaction({
        totalNetPay: "0.00",
        verifiedCheckGross: "0.00",
        verifiedCheckNet: "0.00",
        withholding: "0.00",
      }),
    ]);

    expect(checks).toMatchObject([{
      netPay: "0.00",
      verifiedCheckGross: "0.00",
      verifiedCheckNet: "0.00",
      withholding: "0.00",
      verificationStatus: "verified",
    }]);

    const checksViewSource = readFileSync(
      resolve("src/components/transactions/billed-activity-workspace.tsx"),
      "utf8",
    );
    expect(checksViewSource).toContain("check.verifiedCheckGross !== null");
    expect(checksViewSource).toContain("check.verifiedCheckNet !== null");
    expect(checksViewSource).toContain("check.withholding !== null");
    expect(checksViewSource).toContain('check.verificationStatus === null ? "Not linked"');
    expect(transactionGridSource).toContain("hasAmount(row.verifiedCheckGross)");
    expect(transactionGridSource).toContain("hasAmount(row.verifiedCheckNet)");
    expect(transactionGridSource).toContain("hasAmount(row.withholding)");
  });

  it("does not expose unverified values as verified check facts", () => {
    const checks = groupChecks([
      transaction({ verificationStatus: "unverified" }),
    ]);

    expect(checks).toMatchObject([{
      verifiedCheckGross: null,
      verifiedCheckNet: null,
      withholding: null,
      verificationStatus: "unverified",
    }]);
  });

  it("opens check evidence with a short stable filter instead of every row id", () => {
    const source = readFileSync(resolve("src/components/transactions/billed-activity-workspace.tsx"), "utf8");

    expect(source).toContain('params.set("checkIdentity", check.key)');
    expect(source).toContain('params.set("checkNumber", check.checkNumber)');
    expect(source).not.toContain('params.set("payToKey"');
    expect(source).toContain('params.set("checkDateFrom", check.checkDate)');
    expect(source).toContain('params.set("periodBeginExact", check.periodBegin ?? "")');
    expect(source).toContain('params.set("periodEndExact", check.periodEnd ?? "")');
    expect(source).not.toContain('params.set("pbFrom", check.periodBegin)');
    expect(source).not.toContain('params.append("transactionId"');
  });
});

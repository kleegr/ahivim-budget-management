import { describe, expect, it } from "vitest";
import {
  collectionsFocusedPayrollCheckId,
  collectionsPayrollCheckFocusHref,
  collectionsInitialState,
  collectionsPayrollCheckHref,
  collectionsSettlementSourceParam,
} from "@/lib/nav/collections-links";

const EMPLOYEE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TRANSACTION_ID = "123e4567-e89b-12d3-a456-426614174010";
const PAYROLL_CHECK_ID = "123e4567-e89b-12d3-a456-426614174020";

const fullAccess = {
  canOpenTargets: true,
  canOpenChecks: true,
  canCreateCheck: true,
  employeeIds: [EMPLOYEE_ID],
};

describe("Collections deep links", () => {
  it("opens one exact payroll check in the report month", () => {
    expect(collectionsPayrollCheckFocusHref({
      payrollCheckId: PAYROLL_CHECK_ID,
      month: "2026-08",
    })).toBe(`/masser?view=checks&month=2026-08&focusCheckId=${PAYROLL_CHECK_ID}`);
    expect(collectionsFocusedPayrollCheckId({ focusCheckId: PAYROLL_CHECK_ID })).toBe(PAYROLL_CHECK_ID);
    expect(collectionsFocusedPayrollCheckId({ focusCheckId: "not-a-check" })).toBeNull();
  });

  it("builds a prefilled verified-check URL", () => {
    expect(collectionsPayrollCheckHref({
      employeeId: EMPLOYEE_ID,
      checkNumber: "PAY 10",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      transactionIds: [TRANSACTION_ID],
    })).toBe(
      `/masser?view=checks&newCheck=1&employeeId=${EMPLOYEE_ID}&checkNumber=PAY+10&checkDate=2026-08-15&periodBegin=2026-08-01&periodEnd=2026-08-14&sourceTransactionId=${TRANSACTION_ID}`,
    );
  });

  it("uses one compact source key for a multi-row verified check", () => {
    const sourceId = `${EMPLOYEE_ID}:check:PAY 10:date:2026-08-15`;
    const href = collectionsPayrollCheckHref({
      sourceId,
      employeeId: EMPLOYEE_ID,
      checkNumber: "PAY 10",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      transactionIds: [TRANSACTION_ID, PAYROLL_CHECK_ID],
    });

    if (!href) throw new Error("Expected a compact payroll-check link.");
    expect(new URL(href, "https://ahivim.example").searchParams.get("settlementSource")).toBe(sourceId);
    expect(href).not.toContain("sourceTransactionId=");
    expect(href.length).toBeLessThan(500);
    expect(collectionsSettlementSourceParam({ settlementSource: sourceId })).toBe(sourceId);
  });

  it("refuses to serialize a large explicit fallback when a compact key is invalid", () => {
    expect(collectionsPayrollCheckHref({
      sourceId: `${EMPLOYEE_ID}:check:bad\nnumber:date:2026-08-15`,
      employeeId: EMPLOYEE_ID,
      checkNumber: "bad\nnumber",
      checkDate: "2026-08-15",
      periodBegin: null,
      periodEnd: null,
      transactionIds: Array.from({ length: 21 }, (_, index) => (
        `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`
      )),
    })).toBeNull();
  });

  it("opens Checks and initializes only the permitted employee context", () => {
    expect(collectionsInitialState({
      view: "checks",
      newCheck: "1",
      employeeId: EMPLOYEE_ID,
      checkNumber: " PAY 10 ",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      sourceTransactionId: TRANSACTION_ID,
    }, fullAccess)).toEqual({
      view: "checks",
      checkDraft: {
        employeeId: EMPLOYEE_ID,
        checkNumber: "PAY 10",
        checkDate: "2026-08-15",
        periodBegin: "2026-08-01",
        periodEnd: "2026-08-14",
        sourceTransactionIds: [TRANSACTION_ID],
      },
    });
  });

  it("allows a read-only Checks deep link without opening the form", () => {
    expect(collectionsInitialState({
      view: "checks",
      newCheck: "1",
      employeeId: EMPLOYEE_ID,
    }, { ...fullAccess, canCreateCheck: false })).toEqual({
      view: "checks",
      checkDraft: null,
    });
  });

  it("rejects hidden views, out-of-scope employees, and invalid dates", () => {
    expect(collectionsInitialState({
      view: "checks",
      newCheck: "1",
      employeeId: EMPLOYEE_ID,
    }, { ...fullAccess, canOpenChecks: false })).toEqual({
      view: "summary",
      checkDraft: null,
    });

    expect(collectionsInitialState({
      view: "checks",
      newCheck: "1",
      employeeId: "123e4567-e89b-12d3-a456-426614174001",
      checkDate: "2026-02-31",
    }, fullAccess)).toEqual({
      view: "checks",
      checkDraft: null,
    });
  });

  it("rejects a tampered source transaction list before opening the form", () => {
    expect(collectionsInitialState({
      view: "checks",
      newCheck: "1",
      employeeId: EMPLOYEE_ID,
      sourceTransactionId: [TRANSACTION_ID, "not-a-transaction"],
    }, fullAccess)).toEqual({
      view: "checks",
      checkDraft: null,
    });
  });

  it("accepts only server-resolved source rows for a compact source link", () => {
    const search = {
      view: "checks",
      newCheck: "1",
      employeeId: EMPLOYEE_ID,
      settlementSource: `${EMPLOYEE_ID}:check:PAY 10:date:2026-08-15`,
    };

    expect(collectionsInitialState(search, fullAccess, {
      resolvedSourceTransactionIds: [TRANSACTION_ID, PAYROLL_CHECK_ID],
    }).checkDraft?.sourceTransactionIds).toEqual([TRANSACTION_ID, PAYROLL_CHECK_ID]);
    expect(collectionsInitialState(search, fullAccess, {
      resolvedSourceTransactionIds: null,
    }).checkDraft).toBeNull();
    expect(collectionsInitialState(search, fullAccess, {
      resolvedSourceTransactionIds: Array.from({ length: 201 }, (_, index) => (
        `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`
      )),
    }).checkDraft).toBeNull();
  });
});

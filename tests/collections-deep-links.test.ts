import { describe, expect, it } from "vitest";
import {
  collectionsInitialState,
  collectionsPayrollCheckHref,
} from "@/lib/nav/collections-links";

const EMPLOYEE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TRANSACTION_ID = "123e4567-e89b-12d3-a456-426614174010";

const fullAccess = {
  canOpenTargets: true,
  canOpenChecks: true,
  canCreateCheck: true,
  employeeIds: [EMPLOYEE_ID],
};

describe("Collections deep links", () => {
  it("builds a prefilled verified-check URL", () => {
    expect(collectionsPayrollCheckHref({
      employeeId: EMPLOYEE_ID,
      checkNumber: "PAY 10",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      transactionIds: [TRANSACTION_ID],
    })).toBe(
      `/collections?view=checks&newCheck=1&employeeId=${EMPLOYEE_ID}&checkNumber=PAY+10&checkDate=2026-08-15&periodBegin=2026-08-01&periodEnd=2026-08-14&sourceTransactionId=${TRANSACTION_ID}`,
    );
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
});

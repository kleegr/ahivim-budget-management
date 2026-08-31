import { describe, expect, it } from "vitest";
import {
  settlementCheckIssueAction,
  settlementCheckIssueHref,
  settlementFocusFromParam,
  settlementMissingDealsState,
  settlementQueueFilters,
  settlementQueueFromParam,
} from "@/components/settlements/deep-links";

describe("Money operations deep links", () => {
  it("accepts only supported queue values", () => {
    expect(settlementQueueFromParam("open")).toBe("open");
    expect(settlementQueueFromParam("payable")).toBe("payable");
    expect(settlementQueueFromParam("receivable")).toBe("receivable");
    expect(settlementQueueFromParam("reserve")).toBe("reserve");
    expect(settlementQueueFromParam("credit")).toBe("credit");
    expect(settlementQueueFromParam("completed")).toBe("completed");
    expect(settlementQueueFromParam("all")).toBeNull();
    expect(settlementQueueFromParam("unknown")).toBeNull();
    expect(settlementQueueFromParam(undefined)).toBeNull();
  });

  it("maps queues to the same filters used by the interactive queue buttons", () => {
    expect(settlementQueueFilters("open")).toEqual({
      state: { selected: ["open", "partial", "credit"] },
    });
    expect(settlementQueueFilters("payable")).toEqual({
      direction: { selected: ["payable"] },
      state: { selected: ["open", "partial"] },
    });
    expect(settlementQueueFilters("receivable")).toEqual({
      direction: { selected: ["receivable"] },
      state: { selected: ["open", "partial"] },
    });
    expect(settlementQueueFilters("reserve")).toEqual({
      direction: { selected: ["reserve"] },
      state: { selected: ["open", "partial"] },
    });
    expect(settlementQueueFilters("credit")).toEqual({ state: { selected: ["credit"] } });
    expect(settlementQueueFilters("completed")).toEqual({ state: { selected: ["settled"] } });
  });

  it("accepts only supported corrective focus targets", () => {
    expect(settlementFocusFromParam("refresh")).toBe("refresh");
    expect(settlementFocusFromParam("missing-deals")).toBe("missing-deals");
    expect(settlementFocusFromParam("check-issues")).toBe("check-issues");
    expect(settlementFocusFromParam("transactions")).toBeNull();
    expect(settlementFocusFromParam(null)).toBeNull();
  });

  it("does not claim missing deals are clear when deal visibility is restricted", () => {
    expect(settlementMissingDealsState({
      focused: true,
      canSeeEmployeeDeals: false,
      missingDealCount: 0,
    })).toBe("permission-limited");
    expect(settlementMissingDealsState({
      focused: true,
      canSeeEmployeeDeals: true,
      missingDealCount: 0,
    })).toBe("clear");
  });

  it("opens a real single source transaction by its UUID", () => {
    expect(settlementCheckIssueHref({
      sourceId: "123e4567-e89b-12d3-a456-426614174000",
      employeeId: "employee-1",
      checkNumber: "9001",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      transactionCount: 1,
    })).toBe("/transactions?transactionId=123e4567-e89b-12d3-a456-426614174000");
  });

  it("keeps a reused check number scoped to its canonical check date", () => {
    expect(settlementCheckIssueHref({
      sourceId: "employee-1:check:9001",
      employeeId: "employee-1",
      checkNumber: "9001",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      transactionCount: 3,
    })).toBe("/transactions?employeeId=employee-1&checkNumber=9001&period=2026-08-15..2026-08-15");

    expect(settlementCheckIssueHref({
      sourceId: "employee-1:check:9001:date:2026-09-15",
      employeeId: "employee-1",
      checkNumber: "9001",
      checkDate: "2026-09-15",
      periodBegin: "2026-09-01",
      periodEnd: "2026-09-14",
      transactionCount: 3,
    })).toBe("/transactions?employeeId=employee-1&checkNumber=9001&period=2026-09-15..2026-09-15");

    expect(settlementCheckIssueHref({
      sourceId: "123e4567-e89b-12d3-a456-426614174000",
      employeeId: "employee-1",
      checkNumber: "9002",
      checkDate: null,
      periodBegin: null,
      periodEnd: null,
      transactionCount: 2,
    })).toBe("/transactions?employeeId=employee-1&checkNumber=9002");
  });

  it("opens every same-number row when the check date itself conflicts", () => {
    expect(settlementCheckIssueHref({
      sourceId: "employee-1:ambiguous-check:9001",
      employeeId: "employee-1",
      checkNumber: "9001",
      checkDate: "2026-08-15",
      periodBegin: null,
      periodEnd: null,
      transactionCount: 3,
      issue: "conflicting_check_date",
    })).toBe("/transactions?employeeId=employee-1&checkNumber=9001");
  });

  it("routes check facts to a verified-check form and source-only issues to their rows", () => {
    const transactionIds = [
      "123e4567-e89b-12d3-a456-426614174010",
      "123e4567-e89b-12d3-a456-426614174011",
      "123e4567-e89b-12d3-a456-426614174012",
    ];
    const issue = {
      sourceId: "employee-1:check:9001:date:2026-08-15",
      employeeId: "123e4567-e89b-12d3-a456-426614174000",
      checkNumber: "9001",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      transactionCount: 3,
      transactionIds,
      issue: "conflicting_net" as const,
    };
    expect(settlementCheckIssueAction(issue, {
      canRecordPayrollCheck: true,
      canSeeTransactions: true,
    })).toEqual({
      label: "Record verified check",
      href: "/masser?view=checks&newCheck=1&employeeId=123e4567-e89b-12d3-a456-426614174000&checkNumber=9001&checkDate=2026-08-15&periodBegin=2026-08-01&periodEnd=2026-08-14&sourceTransactionId=123e4567-e89b-12d3-a456-426614174010&sourceTransactionId=123e4567-e89b-12d3-a456-426614174011&sourceTransactionId=123e4567-e89b-12d3-a456-426614174012",
    });

    expect(settlementCheckIssueAction({ ...issue, issue: "missing_base" }, {
      canRecordPayrollCheck: true,
      canSeeTransactions: true,
    })).toEqual({
      label: "Inspect source rows",
      href: "/transactions?transactionId=123e4567-e89b-12d3-a456-426614174010&transactionId=123e4567-e89b-12d3-a456-426614174011&transactionId=123e4567-e89b-12d3-a456-426614174012",
    });
  });

  it("sends conflicting dates to their exact source rows instead of auto-linking them", () => {
    const issue = {
      sourceId: "employee-1:ambiguous-check:9001",
      transactionIds: [
        "123e4567-e89b-12d3-a456-426614174010",
        "123e4567-e89b-12d3-a456-426614174011",
      ],
      employeeId: "123e4567-e89b-12d3-a456-426614174000",
      checkNumber: "9001",
      checkDate: "2026-08-15",
      periodBegin: null,
      periodEnd: null,
      transactionCount: 2,
      issue: "conflicting_check_date" as const,
    };

    expect(settlementCheckIssueAction(issue, {
      canRecordPayrollCheck: true,
      canSeeTransactions: true,
    })).toEqual({
      label: "Inspect source rows",
      href: "/transactions?transactionId=123e4567-e89b-12d3-a456-426614174010&transactionId=123e4567-e89b-12d3-a456-426614174011",
    });
  });

  it("falls back to a service period, then a check date, for composite sources", () => {
    expect(settlementCheckIssueHref({
      sourceId: "employee-1:period:2026-08-01:2026-08-14",
      employeeId: "employee-1",
      checkNumber: null,
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      transactionCount: 2,
    })).toBe("/transactions?employeeId=employee-1&pbFrom=2026-08-01&pbTo=2026-08-14");

    expect(settlementCheckIssueHref({
      sourceId: "employee-1:date:2026-08-15",
      employeeId: "employee-1",
      checkNumber: null,
      checkDate: "2026-08-15",
      periodBegin: null,
      periodEnd: null,
      transactionCount: 2,
    })).toBe("/transactions?employeeId=employee-1&period=2026-08-15..2026-08-15");
  });
});

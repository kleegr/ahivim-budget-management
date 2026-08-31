import { describe, expect, it } from "vitest";
import {
  agencyRoutedEmployeeShare,
  approvedMonthlySetAside,
  classInvoiceSplit,
  directPayCheckAmounts,
} from "@/lib/data/agency-financial-report";

describe("agency financial report math", () => {
  it("uses a person rule before the employee default and never uses funder gross", () => {
    expect(agencyRoutedEmployeeShare({
      baseAmount: "800.0000",
      personSharePercent: "0.750000",
      employeeAgencyCutPercent: "0.100000",
    })).toEqual({ amount: "600.0000", percent: "0.750000", source: "person_rule" });

    expect(agencyRoutedEmployeeShare({
      baseAmount: "800.0000",
      personSharePercent: null,
      employeeAgencyCutPercent: "0.200000",
    })).toEqual({ amount: "640.0000", percent: "0.800000", source: "employee_default" });
  });

  it("calculates direct-pay expenses from check net once and excludes negative taxes", () => {
    expect(directPayCheckAmounts({
      grossAmount: "1000.0000",
      netAmount: "800.0000",
      directRule: "giveback_percent",
      directPercent: "0.200000",
    })).toEqual({ taxes: "200.0000", employeeKeeps: "640.0000", employeeOwesAgency: "160.0000" });

    expect(directPayCheckAmounts({
      grossAmount: "750.0000",
      netAmount: "800.0000",
      directRule: "keep_all",
      directPercent: "0",
    })).toEqual({ taxes: null, employeeKeeps: "800.0000", employeeOwesAgency: "0.0000" });
  });

  it("normalizes a negative approved final into one positive monthly expense", () => {
    expect(approvedMonthlySetAside("-1500.0000")).toBe("1500.0000");
    expect(approvedMonthlySetAside("1500.0000")).toBe("1500.0000");
    expect(approvedMonthlySetAside(null)).toBeNull();
  });

  it("requires an effective class split only after a custom split has been introduced", () => {
    expect(classInvoiceSplit({
      grossAmount: "1000.0000",
      agencySharePercent: null,
      customSplitRequired: false,
    })).toEqual({
      agencySharePercent: "1.000000",
      agencyAmount: "1000.0000",
      individualExpense: "0.0000",
      source: "full_agency_default",
    });
    expect(classInvoiceSplit({
      grossAmount: "1000.0000",
      agencySharePercent: null,
      customSplitRequired: true,
    }).source).toBe("missing");
  });
});

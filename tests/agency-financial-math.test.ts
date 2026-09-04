import { describe, expect, it } from "vitest";
import {
  agencyShareOfEmployeeBase,
  agencyRoutedEmployeeShare,
  approvedMonthlySetAside,
  classInvoiceSplit,
  directPayCheckAmounts,
  transactionAgencySpread,
} from "@/lib/data/agency-financial-report";
import { dec } from "@/lib/money";

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

  it("keeps funder spread outside the deal and assigns the exact base residual to the agency", () => {
    expect(transactionAgencySpread("25.0000", "21.0000")).toBe("4.0000");
    expect(transactionAgencySpread("19.0000", "21.0000")).toBe("-2.0000");
    expect(transactionAgencySpread("25.0000", null)).toBeNull();

    expect(agencyShareOfEmployeeBase("21.0000", "15.7500")).toBe("5.2500");
    expect(agencyShareOfEmployeeBase("21.0000", null)).toBeNull();
  });

  it("calculates direct-pay expense from verified net and independent withholding", () => {
    expect(directPayCheckAmounts({
      netAmount: "800.0000",
      taxWithheld: "125.0000",
      directRule: "giveback_percent",
      directPercent: "0.200000",
    })).toEqual({ taxes: "125.0000", employeeKeeps: "640.0000", employeeOwesAgency: "160.0000" });

    expect(directPayCheckAmounts({
      netAmount: "800.0000",
      taxWithheld: null,
      directRule: "keep_all",
      directPercent: "0",
    })).toEqual({ taxes: null, employeeKeeps: "800.0000", employeeOwesAgency: "0.0000" });
  });

  it("preserves the documented August money-operation benchmark identities", () => {
    expect(dec("47973.56").minus("43210.36").toFixed(2)).toBe("4763.20");
    expect(dec("47658.81").minus("42940.77").toFixed(2)).toBe("4718.04");
    expect(dec("47658.81").minus("33930.00").toFixed(2)).toBe("13728.81");
    expect(dec("36290.00").minus("33930.00").toFixed(2)).toBe("2360.00");
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

import { describe, expect, it } from "vitest";
import {
  aggregateEmployeeDeals,
  calculateAgencyRoutedTransaction,
  calculateDirectEmployeeCheck,
} from "@/lib/business/deal-engine";

describe("employee deal engine", () => {
  describe("agency-routed transactions", () => {
    it("keeps the billed/base spread outside a 20% base deal", () => {
      const result = calculateAgencyRoutedTransaction({
        flow: "agency_routed",
        transactionId: "tx-1",
        billedAmount: "25",
        baseAmount: "21",
        deal: { agencyCutFraction: "0.20" },
      });

      expect(result).toMatchObject({
        billedAmount: "25.0000",
        baseAmount: "21.0000",
        agencySpread: "4.0000",
        agencyCut: "4.2000",
        employeePayable: "16.8000",
        agencyKeepsTotal: "8.2000",
      });
      expect(result.reconciliations.every((check) => check.reconciles)).toBe(true);
    });

    it("preserves a negative spread as a correction instead of clamping it", () => {
      const result = calculateAgencyRoutedTransaction({
        flow: "agency_routed",
        transactionId: "tx-correction",
        billedAmount: "19",
        baseAmount: "21",
        deal: { agencyCutFraction: "0.20" },
      });

      expect(result.agencySpread).toBe("-2.0000");
      expect(result.agencyCut).toBe("4.2000");
      expect(result.employeePayable).toBe("16.8000");
      expect(result.agencyKeepsTotal).toBe("2.2000");
      expect(result.reconciliations.every((check) => check.difference === "0.0000")).toBe(true);
    });

    it("rounds the cut once and gives the employee the exact residual", () => {
      const result = calculateAgencyRoutedTransaction({
        flow: "agency_routed",
        transactionId: "tx-rounding",
        billedAmount: "0.015",
        baseAmount: "0.01",
        deal: { agencyCutFraction: "0.333333" },
      });

      expect(result.billedAmount).toBe("0.0150");
      expect(result.agencySpread).toBe("0.0050");
      expect(result.agencyCut).toBe("0.0033");
      expect(result.employeePayable).toBe("0.0067");
      expect(result.reconciliations.every((check) => check.reconciles)).toBe(true);
    });
  });

  describe("direct employee checks", () => {
    it("calculates a percentage give-back from whole check net, never gross", () => {
      const result = calculateDirectEmployeeCheck({
        flow: "direct_employee",
        checkId: "employee-1:check-100",
        checkGross: "1500",
        checkNet: "1200",
        deal: { mode: "giveback_percent", givebackFraction: "0.10" },
      });

      expect(result).toMatchObject({
        checkGross: "1500.0000",
        checkNet: "1200.0000",
        withholding: "300.0000",
        employeeOwesAgency: "120.0000",
        employeeKeeps: "1080.0000",
      });
      expect(result.reconciliations[0]).toMatchObject({
        expected: "1200.0000",
        actual: "1200.0000",
        difference: "0.0000",
        reconciles: true,
      });
    });

    it("supports keep all without using gross or withholding", () => {
      const result = calculateDirectEmployeeCheck({
        flow: "direct_employee",
        checkId: "check-keep-all",
        checkNet: "812.34",
        deal: { mode: "keep_all" },
      });

      expect(result.checkGross).toBeNull();
      expect(result.withholding).toBeNull();
      expect(result.employeeKeeps).toBe("812.3400");
      expect(result.employeeOwesAgency).toBe("0.0000");
    });

    it("give back all means all net while withholding remains untouched", () => {
      const result = calculateDirectEmployeeCheck({
        flow: "direct_employee",
        checkId: "check-giveback-all",
        checkGross: "1500",
        checkNet: "1200",
        deal: { mode: "giveback_all" },
      });

      expect(result.withholding).toBe("300.0000");
      expect(result.employeeOwesAgency).toBe("1200.0000");
      expect(result.employeeKeeps).toBe("0.0000");
    });

    it("preserves net conservation after percentage rounding", () => {
      const result = calculateDirectEmployeeCheck({
        flow: "direct_employee",
        checkId: "check-rounding",
        checkNet: "0.01",
        deal: { mode: "giveback_percent", givebackFraction: "0.333333" },
      });

      expect(result.employeeOwesAgency).toBe("0.0033");
      expect(result.employeeKeeps).toBe("0.0067");
      expect(result.reconciliations[0]!.reconciles).toBe(true);
    });
  });

  describe("check-level aggregation", () => {
    it("totals routed rows and direct checks without mixing obligation directions", () => {
      const result = aggregateEmployeeDeals({
        agencyRoutedTransactions: [
          {
            flow: "agency_routed",
            transactionId: "agency-1",
            billedAmount: "25",
            baseAmount: "21",
            deal: { agencyCutFraction: "0.20" },
          },
          {
            flow: "agency_routed",
            transactionId: "agency-2",
            billedAmount: "50",
            baseAmount: "42",
            deal: { agencyCutFraction: "0.10" },
          },
        ],
        directEmployeeChecks: [
          {
            flow: "direct_employee",
            checkId: "direct-1",
            checkGross: "1500",
            checkNet: "1200",
            deal: { mode: "giveback_percent", givebackFraction: "0.10" },
          },
          {
            flow: "direct_employee",
            checkId: "direct-2",
            checkNet: "500",
            deal: { mode: "keep_all" },
          },
        ],
      });

      expect(result.agencyRouted).toEqual({
        transactionCount: 2,
        billedAmount: "75.0000",
        baseAmount: "63.0000",
        agencySpread: "12.0000",
        agencyCut: "8.4000",
        employeePayable: "54.6000",
        agencyKeepsTotal: "20.4000",
      });
      expect(result.directEmployee).toEqual({
        checkCount: 2,
        checkNet: "1700.0000",
        employeeKeeps: "1580.0000",
        employeeOwesAgency: "120.0000",
        knownCheckGross: "1500.0000",
        knownWithholding: "300.0000",
        checksWithGross: 1,
      });
      expect(result.obligations).toEqual({
        agencyOwesEmployees: "54.6000",
        employeesOweAgency: "120.0000",
      });
      expect(result.reconciliations.every((check) => check.reconciles)).toBe(true);
    });

    it("rejects duplicate direct check identities so repeated net is not double-counted", () => {
      expect(() =>
        aggregateEmployeeDeals({
          agencyRoutedTransactions: [],
          directEmployeeChecks: [
            {
              flow: "direct_employee",
              checkId: "same-check",
              checkNet: "1200",
              deal: { mode: "keep_all" },
            },
            {
              flow: "direct_employee",
              checkId: "same-check",
              checkNet: "1200",
              deal: { mode: "keep_all" },
            },
          ],
        }),
      ).toThrow("Duplicate checkId: same-check");
    });

    it("returns exact zero totals for an empty ledger", () => {
      const result = aggregateEmployeeDeals({
        agencyRoutedTransactions: [],
        directEmployeeChecks: [],
      });

      expect(result.agencyRouted.baseAmount).toBe("0.0000");
      expect(result.directEmployee.checkNet).toBe("0.0000");
      expect(result.obligations).toEqual({
        agencyOwesEmployees: "0.0000",
        employeesOweAgency: "0.0000",
      });
      expect(result.reconciliations.every((check) => check.reconciles)).toBe(true);
    });
  });

  it.each(["-0.01", "1.000001"])("rejects an out-of-range deal fraction %s", (fraction) => {
    expect(() =>
      calculateAgencyRoutedTransaction({
        flow: "agency_routed",
        transactionId: "tx-invalid",
        billedAmount: "25",
        baseAmount: "21",
        deal: { agencyCutFraction: fraction },
      }),
    ).toThrow("agencyCutFraction must be between 0 and 1 inclusive");
  });
});

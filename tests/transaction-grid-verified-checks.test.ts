import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { redactTransactionFields } from "@/lib/auth/money-redaction";

describe("Transactions verified payroll-check facts", () => {
  it("loads linked canonical check facts without replacing imported source values", () => {
    const source = readFileSync(resolve("src/lib/data/transactions-grid.ts"), "utf8");

    expect(source).toContain("LEFT JOIN employee_payroll_checks pc");
    expect(source).toContain("ON pc.id = t.payroll_check_id");
    expect(source).toContain("AND pc.employee_id = t.employee_id");
    expect(source.match(/pc\.verification_status = 'verified'/g)).toHaveLength(3);
    expect(source).toContain("THEN pc.actual_gross END");
    expect(source).toContain("THEN pc.actual_net END");
    expect(source).toContain("THEN pc.tax_withheld END");
    expect(source).toContain("t.total_net_pay::text");
    expect(source).toContain("t.internal_rate_applied::text");
  });

  it("keeps every requested check fact available in the grid", () => {
    const source = readFileSync(resolve("src/components/transactions/transactions-grid.tsx"), "utf8");

    for (const label of [
      "Funder rate",
      "Employee rate",
      "Verified check gross",
      "Verified check net",
      "Withholding",
      "Check status",
      "Code",
    ]) {
      expect(source).toContain(`label: "${label}"`);
    }
  });

  it("redacts employee-rate, verified-check metadata, and tax amounts at the server boundary", () => {
    const redacted = redactTransactionFields({
      employeeRate: "21.00",
      verifiedCheckGross: "100.00",
      verifiedCheckNet: "80.00",
      withholding: "20.00",
      verificationStatus: "verified",
    }, {
      canSeeMoney: true,
      canSeeHours: true,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: false,
      canSeeAgencySpread: true,
      canSeeCheckNet: false,
      canSeeTaxes: false,
      canSeeBudgets: true,
      canSeeEmployeeDeals: false,
      canSeeSettlements: false,
      canSeeClassFinancials: false,
      canManageClassInvoices: false,
    });

    expect(redacted).toMatchObject({
      employeeRate: null,
      verifiedCheckGross: null,
      verifiedCheckNet: null,
      withholding: null,
      verificationStatus: null,
    });
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  calculateRevenueSplit,
  percentInputToFraction,
} from "@/lib/manage/agency-financials";

describe("agency financial management math", () => {
  it("stores percentage-form inputs as fractions", () => {
    expect(percentInputToFraction("75")).toBe("0.750000");
    expect(percentInputToFraction("0.25")).toBe("0.250000");
    expect(percentInputToFraction("100%")).toBe("1.000000");
  });

  it("keeps the rounded agency share and individual residual equal to gross", () => {
    const split = calculateRevenueSplit("100.01", "0.333333");
    expect(split).toEqual({
      grossAmount: "100.0100",
      agencyAmount: "33.3366",
      individualAmount: "66.6734",
    });
  });

  it("supports full agency and full individual allocations", () => {
    expect(calculateRevenueSplit("250", "1")).toEqual({
      grossAmount: "250.0000",
      agencyAmount: "250.0000",
      individualAmount: "0.0000",
    });
    expect(calculateRevenueSplit("250", "0")).toEqual({
      grossAmount: "250.0000",
      agencyAmount: "0.0000",
      individualAmount: "250.0000",
    });
  });

  it("rejects invalid percentages and amounts", () => {
    expect(() => percentInputToFraction("125")).toThrow(/between/i);
    expect(() => calculateRevenueSplit("0", "0.5")).toThrow(/greater than zero/i);
    expect(() => calculateRevenueSplit("100", "-0.1")).toThrow(/between/i);
  });

  it("keeps manual income and both effective-dated split types auditable", () => {
    const migration = readFileSync(
      join(process.cwd(), "drizzle", "0036_agency_financial_actuals.sql"),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "agency_manual_income_entries"');
    expect(migration).toContain('CREATE TABLE "individual_program_revenue_terms"');
    expect(migration).toContain('CREATE TABLE "employee_individual_compensation_terms"');
    expect(migration).toContain('CREATE TRIGGER "employee_individual_compensation_terms_settlement_dirty"');
    expect(migration).toContain('EXECUTE FUNCTION "mark_settlement_ledger_dirty"()');
    expect(migration).toContain('"agency_amount" + "individual_amount" = "gross_amount"');
    expect(migration).toContain('"status" IN (\'active\', \'void\')');
  });

  it("serializes concurrent edits to the same effective-dated rule", () => {
    const service = readFileSync(
      join(process.cwd(), "src", "lib", "manage", "agency-financials.ts"),
      "utf8",
    );
    expect(service).toContain("agency-program-split:${input.individualId}:${input.programId}");
    expect(service).toContain("employee-individual-pay:${input.employeeId}:${input.individualId}");
    expect(service).toContain("timezone('America/New_York', now())::date");
  });

  it("uses a person-specific employee share before the employee default", () => {
    const settlements = readFileSync(
      join(process.cwd(), "src", "lib", "manage", "settlements.ts"),
      "utf8",
    );
    expect(settlements).toContain("LEFT JOIN LATERAL (\n         SELECT term.id, term.revision, term.employee_share_percent");
    expect(settlements).toContain("CASE WHEN compensation.id IS NOT NULL");
    expect(settlements).toContain("THEN (1 - compensation.employee_share_percent)::text");
    expect(settlements).toContain("individualId: null");
    expect(settlements).toContain("sourceIndividualId: first.individual_id");
  });

  it("keeps duplicate-person merges from combining overlapping financial terms", () => {
    const individualMerge = readFileSync(
      join(process.cwd(), "src", "lib", "manage", "individual-merge.ts"),
      "utf8",
    );
    const employeeMerge = readFileSync(
      join(process.cwd(), "src", "lib", "manage", "employee-merge.ts"),
      "utf8",
    );
    expect(individualMerge).toContain("Resolve overlapping program income split history");
    expect(individualMerge).toContain("Resolve overlapping employee pay-rule history");
    expect(employeeMerge).toContain("Resolve overlapping individual pay-rule history");
  });
});

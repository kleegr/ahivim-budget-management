import { describe, it, expect } from "vitest";
import { classifyGroupCandidate } from "@/lib/manage/group-detection";
import { classifyMatch } from "@/lib/manage/reconciliation";

describe("group-candidate classification", () => {
  it("a single-individual session is not a group", () => {
    expect(classifyGroupCandidate({ groupSize: 1, moneyReconciles: true, memberCountMatches: true, rateConsistent: true })).toBe("not_a_group");
  });
  it("money that does not reconcile requires review (never fabricate a split)", () => {
    expect(classifyGroupCandidate({ groupSize: 3, moneyReconciles: false, memberCountMatches: true, rateConsistent: true })).toBe("requires_review");
  });
  it("money reconciles + member count + rate consistent => confirmed", () => {
    expect(classifyGroupCandidate({ groupSize: 3, moneyReconciles: true, memberCountMatches: true, rateConsistent: true })).toBe("confirmed");
  });
  it("money reconciles but a check disagrees => probable", () => {
    expect(classifyGroupCandidate({ groupSize: 3, moneyReconciles: true, memberCountMatches: false, rateConsistent: true })).toBe("probable");
    expect(classifyGroupCandidate({ groupSize: 3, moneyReconciles: true, memberCountMatches: true, rateConsistent: false })).toBe("probable");
  });
});

describe("scheduled-vs-actual match classification", () => {
  const base = { employeeId: "e1", programId: "p1" };
  it("everything agreeing is exact", () => {
    expect(classifyMatch(
      { durationHours: "3", expectedInternalAmount: "51", ...base },
      { importedHours: "3", importedAmount: "51", ...base },
    )).toBe("exact");
  });
  it("a different program dominates", () => {
    expect(classifyMatch(
      { durationHours: "3", expectedInternalAmount: "51", employeeId: "e1", programId: "p1" },
      { importedHours: "3", importedAmount: "51", employeeId: "e1", programId: "p2" },
    )).toBe("program_mismatch");
  });
  it("a different employee (same program) is an employee mismatch", () => {
    expect(classifyMatch(
      { durationHours: "3", expectedInternalAmount: "51", employeeId: "e1", programId: "p1" },
      { importedHours: "3", importedAmount: "51", employeeId: "e2", programId: "p1" },
    )).toBe("employee_mismatch");
  });
  it("hours off but amount equal is an hours mismatch", () => {
    expect(classifyMatch(
      { durationHours: "3", expectedInternalAmount: "51", ...base },
      { importedHours: "4", importedAmount: "51", ...base },
    )).toBe("hours_mismatch");
  });
  it("amount off but hours equal is an amount mismatch", () => {
    expect(classifyMatch(
      { durationHours: "3", expectedInternalAmount: "51", ...base },
      { importedHours: "3", importedAmount: "60", ...base },
    )).toBe("amount_mismatch");
  });
  it("both hours and amount off is only probable", () => {
    expect(classifyMatch(
      { durationHours: "3", expectedInternalAmount: "51", ...base },
      { importedHours: "5", importedAmount: "90", ...base },
    )).toBe("probable");
  });
  it("missing data never flags a mismatch", () => {
    expect(classifyMatch(
      { durationHours: null, expectedInternalAmount: null, employeeId: null, programId: null },
      { importedHours: "3", importedAmount: "51", employeeId: "e1", programId: "p1" },
    )).toBe("exact");
  });
});

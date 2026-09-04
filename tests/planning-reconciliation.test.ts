import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import type { PgLikePool } from "@/lib/import/commit";
import { emptyPlanningMatchReview, getPlanningMatchReview } from "@/lib/data/planning-reconciliation";

const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000002";
const AGENCY_ID = "00000000-0000-4000-8000-000000000003";

function plannerScope(): AccessScope {
  return {
    ...fullAccess("00000000-0000-4000-8000-000000000004", "viewer"),
    full: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [INDIVIDUAL_ID],
    employeeIds: [EMPLOYEE_ID],
    grantedIndividualIds: [INDIVIDUAL_ID],
    grantedEmployeeIds: [EMPLOYEE_ID],
    canSeeTransactions: false,
    canSeeMoney: false,
    canSeeBilledAmounts: false,
    canSeeEmployeeAmounts: false,
    canSeeAgencySpread: false,
    canSeeCheckNet: false,
    canSeeTaxes: false,
    canSeeEmployeeDeals: false,
    canSeeSettlements: false,
    canManageSettlements: false,
  };
}

describe("planning schedule match review", () => {
  it("provides an empty model without touching the database outside the matching view", () => {
    expect(emptyPlanningMatchReview()).toEqual({
      rows: [],
      total: 0,
      groupCount: 0,
      multipleCount: 0,
      noCandidateCount: 0,
    });
    const page = readFileSync("src/app/(app)/schedule/page.tsx", "utf8");
    expect(page).toContain('initialView === "matching"');
    expect(page).toContain("Promise.resolve(emptyPlanningMatchReview())");
    expect(page).toContain('matchReviewLoaded={initialView === "matching"}');
  });

  it("returns scoped operational hours without financial or transaction identifiers", async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: "00000000-0000-4000-8000-000000000005",
      session_date: "2026-08-28",
      employee_id: EMPLOYEE_ID,
      employee_name: "Planner Employee",
      program_id: "00000000-0000-4000-8000-000000000006",
      program_code: "COM_HAB",
      program_name: "Community Habilitation",
      individual_ids: [INDIVIDUAL_ID],
      individual_names: ["Planner Person"],
      duration_hours: "3",
      is_group: false,
      group_size: 1,
      candidate_count: "2",
      candidate_hours: "6",
      pay_period_candidate_count: "2",
      total_count: "1",
      total_group_count: "0",
      total_multiple_count: "1",
      total_no_candidate_count: "0",
    }] }));
    const result = await getPlanningMatchReview(
      { query } as unknown as PgLikePool,
      "2026-09-01",
      plannerScope(),
      [AGENCY_ID],
    );

    expect(result).toMatchObject({
      total: 1,
      multipleCount: 1,
      rows: [{
        employeeName: "Planner Employee",
        individualNames: ["Planner Person"],
        plannedHours: "3.0000",
        candidateCount: 2,
        candidateHours: "6.0000",
        hasPayPeriodCandidates: true,
        reason: "multiple",
      }],
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["amount", "rate", "check", "transaction", "recipient", "gross", "net", "tax"]) {
      expect(serialized.toLocaleLowerCase()).not.toContain(forbidden);
    }
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(String(sql)).not.toContain("imported_amount");
    expect(String(sql)).not.toContain("imported_rate");
    expect(String(sql)).not.toContain("check_number");
    expect(String(sql)).toContain("canonical_service_date(");
    expect(String(sql)).toContain("actual.period_begin IS NULL OR actual.period_end IS NULL");
    expect(String(sql)).toContain("actual.period_begin IS NOT NULL");
    expect(String(sql)).toContain("actual.period_end IS NOT NULL");
    expect(params).toEqual([
      "2026-09-01",
      [EMPLOYEE_ID],
      [INDIVIDUAL_ID],
      [AGENCY_ID],
      200,
    ]);
  });

  it("keeps the planner panel money-free", () => {
    const source = readFileSync("src/components/schedule/schedule-matching-panel.tsx", "utf8");
    expect(source).not.toContain("<Money");
    expect(source).not.toContain("Funder");
    expect(source).not.toContain("Check number");
    expect(source).toContain("This view contains hours only.");
    expect(source).toContain("Pay-period record needs review");
    expect(source).toContain("Planned per person");
    expect(source).toContain("Possible credited hours");
    expect(source).toContain('row.isGroup ? " each" : ""');
    expect(source).not.toContain("Ready for matching");
  });

  it("labels a covering pay-period total as review, not a confirmed daily match", async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: "00000000-0000-4000-8000-000000000005",
      session_date: "2026-08-28",
      employee_id: EMPLOYEE_ID,
      employee_name: "Planner Employee",
      program_id: "00000000-0000-4000-8000-000000000006",
      program_code: "COM_HAB",
      program_name: "Community Habilitation",
      individual_ids: [INDIVIDUAL_ID],
      individual_names: ["Planner Person"],
      duration_hours: "3",
      is_group: false,
      group_size: 1,
      candidate_count: "1",
      candidate_hours: "24",
      pay_period_candidate_count: "1",
      total_count: "1",
      total_group_count: "0",
      total_multiple_count: "0",
      total_no_candidate_count: "0",
    }] }));

    const result = await getPlanningMatchReview(
      { query } as unknown as PgLikePool,
      "2026-09-01",
      plannerScope(),
    );

    expect(result.rows[0]).toMatchObject({
      reason: "pay_period",
      candidateHours: "24.0000",
      hasPayPeriodCandidates: true,
    });
  });

  it("uses full-result category counts even when only one row is loaded", async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: "00000000-0000-4000-8000-000000000005",
      session_date: "2026-08-28",
      employee_id: EMPLOYEE_ID,
      employee_name: "Planner Employee",
      program_id: "00000000-0000-4000-8000-000000000006",
      program_code: "COM_HAB",
      program_name: "Community Habilitation",
      individual_ids: [INDIVIDUAL_ID],
      individual_names: ["Planner Person"],
      duration_hours: "3",
      is_group: false,
      group_size: 1,
      candidate_count: "0",
      candidate_hours: "0",
      pay_period_candidate_count: "0",
      total_count: "450",
      total_group_count: "38",
      total_multiple_count: "27",
      total_no_candidate_count: "91",
    }] }));

    const result = await getPlanningMatchReview(
      { query } as unknown as PgLikePool,
      "2026-09-01",
      plannerScope(),
    );

    expect(result.rows).toHaveLength(1);
    expect(result).toMatchObject({
      total: 450,
      groupCount: 38,
      multipleCount: 27,
      noCandidateCount: 91,
    });
    const calls = query.mock.calls as unknown as unknown[][];
    const sql = String(calls[0]?.[0] ?? "");
    expect(sql).toContain("total_group_count");
    expect(sql).toContain("total_multiple_count");
    expect(sql).toContain("total_no_candidate_count");
  });

  it("states the loaded range and keeps truncated empty-search wording honest", () => {
    const source = readFileSync("src/components/schedule/schedule-matching-panel.tsx", "utf8");
    expect(source).toContain("Showing ${loadedCount} of ${totalCount} unmatched visits.");
    expect(source).toContain("Showing ${filteredCount} matches from ${loadedCount} loaded of ${totalCount} total unmatched visits.");
    expect(source).toContain("No matches in the ${loadedCount} loaded visits.");
    expect(source).toContain("if (loadedCount < totalCount)");
  });
});

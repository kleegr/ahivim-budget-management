import { describe, expect, it, vi } from "vitest";
import { buildActivityReviewSummary } from "@/lib/data/activity-overview";
import { getOpenSyncConflictCounts } from "@/lib/sheets/queries";
import {
  ACTIVITY_NEXT_STEP_LABELS,
  activityNextStep,
} from "@/lib/transactions/activity-state";

const readyService = {
  individualId: "individual-1",
  employeeId: "employee-1",
  programId: "program-1",
  serviceDate: "2026-08-01",
  paymentRecipient: "employee",
  matchStatus: "new",
  groupDetectionStatus: "single",
  hasOpenRateReview: false,
};

describe("plain Activity decisions", () => {
  it("gives a recorded service one prioritized next step", () => {
    expect(activityNextStep(readyService)).toBe("ready");
    expect(activityNextStep({ ...readyService, individualId: null, programId: null })).toBe("attention_person");
    expect(activityNextStep({ ...readyService, programId: null })).toBe("attention_program");
    expect(activityNextStep({ ...readyService, serviceDate: null })).toBe("attention_date");
    expect(activityNextStep({ ...readyService, paymentRecipient: "unknown" })).toBe("attention_recipient");
    expect(activityNextStep({ ...readyService, groupDetectionStatus: "needs_review" })).toBe("attention_group");
    expect(activityNextStep({ ...readyService, matchStatus: "possible" })).toBe("attention_duplicate");
    expect(activityNextStep({ ...readyService, hasOpenRateReview: true })).toBe("attention_rate");
    expect(ACTIVITY_NEXT_STEP_LABELS.attention_recipient).toBe("Confirm recipient");
  });

  it("includes unresolved source changes in the same decision total", () => {
    const summary = buildActivityReviewSummary({
      unknownPrograms: 2,
      unmatchedNames: 3,
      duplicateIndividuals: 1,
      pendingAliases: 4,
      rateExceptions: 5,
      duplicateCandidates: 6,
      groupReviewIssues: 7,
      reconciliationDifferences: 8,
      overAuthorization: 9,
    }, { changed: 10, missing: 11, total: 21 });

    expect(summary.decisionTotal).toBe(39);
    expect(summary.decisions).toMatchObject({
      changedSourceRecords: 10,
      missingSourceRecords: 11,
    });
    expect(summary.monitoringTotal).toBe(27);
  });

  it("counts only open changed and missing source records", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      return {
        rows: [
          { type: "changed", c: "2" },
          { type: "missing", c: "3" },
        ],
      };
    });

    await expect(getOpenSyncConflictCounts({ query } as never)).resolves.toEqual({
      changed: 2,
      missing: 3,
      total: 5,
    });
    const sql = calls[0] ?? "";
    expect(sql).toContain("status = 'open'");
    expect(sql).toContain("type IN ('changed', 'missing')");
  });
});

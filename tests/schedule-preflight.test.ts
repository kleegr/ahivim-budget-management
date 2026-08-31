import { describe, expect, it } from "vitest";
import {
  schedulePreviewRequiresOverride,
  type PlanningSchedulePreview,
} from "@/lib/business/schedule-preflight";

function preview(overrides: Partial<PlanningSchedulePreview> = {}): PlanningSchedulePreview {
  return {
    durationHours: "2.0000",
    warnings: [],
    forecast: [],
    employeeAvailability: { timeRangeKnown: true, occurrenceCount: 3, employees: [] },
    individualConflicts: { occurrenceCount: 3, individuals: [] },
    seriesAuthorization: { occurrenceCount: 3, durationHours: "2.0000", individuals: [] },
    validationMessage: null,
    ...overrides,
  };
}

describe("schedule preflight warning confirmation", () => {
  it("requires an override for a selected-individual conflict on a later visit", () => {
    const result = preview({
      individualConflicts: {
        occurrenceCount: 3,
        individuals: [{
          individualId: "10000000-0000-4000-8000-000000000001",
          individualName: "Ari Cohen",
          conflictCount: 1,
          conflictingOccurrenceCount: 1,
          conflictingDates: ["2026-09-15"],
        }],
      },
    });

    expect(schedulePreviewRequiresOverride(result, {
      recurring: true,
      selectedEmployeeId: "",
    })).toBe(true);
  });

  it("requires an override when an edited series would exceed authorization", () => {
    const result = preview({
      seriesAuthorization: {
        occurrenceCount: 3,
        durationHours: "2.0000",
        individuals: [{
          individualId: "10000000-0000-4000-8000-000000000001",
          individualName: "Ari Cohen",
          periods: [{
            periodId: "20000000-0000-4000-8000-000000000001",
            periodLabel: "Annual",
            startDate: "2026-01-01",
            endDate: "2026-12-31",
            authorizedHours: "10.0000",
            actualHours: "8.0000",
            scheduledHours: "0.0000",
            seriesOccurrenceCount: 3,
            seriesHours: "6.0000",
            remainingAfterHours: "-4.0000",
            calculationSafe: true,
            sourceCandidateCount: 1,
            sourceAmbiguous: false,
          }],
          uncoveredOccurrenceCount: 0,
          uncoveredHours: "0.0000",
          ambiguousOccurrenceCount: 0,
          ambiguousHours: "0.0000",
          projectionSafe: true,
        }],
      },
    });

    expect(schedulePreviewRequiresOverride(result, {
      recurring: true,
      selectedEmployeeId: "30000000-0000-4000-8000-000000000001",
    })).toBe(true);
  });

  it("allows a conflict-free recurring edit without an override", () => {
    expect(schedulePreviewRequiresOverride(preview(), {
      recurring: true,
      selectedEmployeeId: "",
    })).toBe(false);
  });
});

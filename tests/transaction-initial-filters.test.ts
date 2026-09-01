import { describe, expect, it } from "vitest";
import { buildInitialFilters } from "@/lib/transactions/initial-filters";
import type { GridTransaction } from "@/lib/data/transactions-grid";

describe("transaction URL filters", () => {
  it("filters an actuals report by the same canonical service date used in its totals", () => {
    const rows = [
      {
        id: "period-row",
        serviceDate: "2026-08-01",
        periodBegin: "2026-08-01",
        checkDate: "2026-08-15",
      },
      {
        id: "check-date-fallback",
        serviceDate: "2026-08-20",
        periodBegin: null,
        checkDate: "2026-08-20",
      },
    ] as GridTransaction[];

    expect(buildInitialFilters(rows, {
      serviceFrom: "2026-08-01",
      serviceTo: "2026-08-31",
    })).toEqual({
      filters: { serviceDate: { from: "2026-08-01", to: "2026-08-31" } },
      label: "service dates 2026-08-01 to 2026-08-31",
    });
  });

  it("opens an owner cohort as one multi-person transaction filter", () => {
    const firstId = "10000000-0000-4000-8000-000000000001";
    const secondId = "10000000-0000-4000-8000-000000000002";
    const rows = [
      { individualId: firstId, individual: "Alex One" },
      { individualId: secondId, individual: "Blair Two" },
      { individualId: secondId, individual: "Blair Two" },
    ] as GridTransaction[];

    expect(buildInitialFilters(rows, { individualId: [firstId, secondId] })).toEqual({
      filters: { individual: { selected: ["Alex One", "Blair Two"] } },
      label: "2 people",
    });
  });
});

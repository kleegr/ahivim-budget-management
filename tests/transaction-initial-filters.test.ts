import { describe, expect, it } from "vitest";
import { buildInitialFilters } from "@/lib/transactions/initial-filters";
import type { GridTransaction } from "@/lib/data/transactions-grid";

describe("transaction URL filters", () => {
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

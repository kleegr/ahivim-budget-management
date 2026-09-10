import { describe, expect, it } from "vitest";
import { applyFilters, filterChips } from "@/components/data-grid/engine";
import type { ColumnDef } from "@/components/data-grid/types";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import { withTransactionScopeLabels } from "@/components/transactions/scope-column-labels";

const columns: ColumnDef<GridTransaction>[] = [
  { key: "individualId", label: "individual identity", kind: "text", accessor: row => row.individualId },
  { key: "programId", label: "program identity", kind: "text", accessor: row => row.programId },
];
const rows = [
  { individualId: "person-a", individual: "Same display name", programId: "program-a", program: "Day Hab" },
  { individualId: "person-b", individual: "Same display name", programId: "program-a", program: "Day Hab" },
] as GridTransaction[];

describe("readable exact-record investigation filters", () => {
  it("shows names while retaining exact identity matching for people with duplicate names", () => {
    const presented = withTransactionScopeLabels(columns, rows);
    const filters = { individualId: { selected: ["person-a"] }, programId: { selected: ["program-a"] } };
    expect(filterChips(presented, filters).map(chip => chip.label)).toEqual([
      "Selected person: Same display name", "Selected program: Day Hab",
    ]);
    expect(applyFilters(rows, presented, filters, "", [])).toEqual([rows[0]]);
    expect(filters.individualId.selected).toEqual(["person-a"]);
  });
  it("does not display an unknown or inaccessible record ID or infer another person's name", () => {
    const presented = withTransactionScopeLabels(columns, rows);
    const filters = { individualId: { selected: ["private-person-id"] } };
    expect(filterChips(presented, filters)[0].label).toBe("Selected person: Record unavailable in this view");
    expect(applyFilters(rows, presented, filters, "", [])).toEqual([]);
  });
  it("uses existing readable badge labels without changing stored filter values", () => {
    const badges: ColumnDef<GridTransaction>[] = [{ key: "status", label: "Status", kind: "badge", accessor: () => "needs_review", badgeLabels: { needs_review: "Needs review" } }];
    expect(filterChips(badges, { status: { selected: ["needs_review"] } })[0].label).toBe("Status: Needs review");
  });
});

import { describe, it, expect } from "vitest";
import type { ColumnDef } from "@/components/data-grid/types";
import {
  passesFilter,
  filterActive,
  applyFilters,
  sortRows,
  valueCountsFor,
  toggleSortState,
  filterChips,
  formatCell,
  exportColumns,
  exportRows,
  anyFilterActive,
} from "@/components/data-grid/engine";

interface Row {
  name: string;
  program: string;
  gross: string | null;
  date: string;
}

const cols: ColumnDef<Row>[] = [
  { key: "name", label: "Name", kind: "text", accessor: (r) => r.name },
  { key: "program", label: "Program", kind: "text", accessor: (r) => r.program },
  { key: "gross", label: "Gross", kind: "money", accessor: (r) => r.gross },
  { key: "date", label: "Date", kind: "date", accessor: (r) => r.date },
];

const rows: Row[] = [
  { name: "Aaron", program: "Respite", gross: "100.00", date: "2025-01-01" },
  { name: "Bella", program: "Com Hab", gross: "250.50", date: "2025-03-15" },
  { name: "Cara", program: "Respite", gross: null, date: "2025-02-10" },
  { name: "Dov", program: "Day Hab", gross: "1000.00", date: "2025-06-01" },
];

const searchKeys = ["name", "program"];

describe("data-grid engine", () => {
  it("text selected filter keeps only matching values", () => {
    const f = { program: { selected: ["Respite"] } };
    const out = applyFilters(rows, cols, f, "", searchKeys);
    expect(out.map((r) => r.name)).toEqual(["Aaron", "Cara"]);
  });

  it("contains filter is case-insensitive", () => {
    const gross = cols[2];
    const name = cols[0];
    expect(passesFilter(name, rows[0], { contains: "aar" })).toBe(true);
    expect(passesFilter(gross, rows[0], {})).toBe(true);
  });

  it("numeric min/max bounds; null value fails a set bound", () => {
    const gross = cols[2];
    expect(passesFilter(gross, rows[0], { min: "150" })).toBe(false);
    expect(passesFilter(gross, rows[1], { min: "150" })).toBe(true);
    expect(passesFilter(gross, rows[2], { min: "150" })).toBe(false); // null gross
    expect(passesFilter(gross, rows[3], { min: "150", max: "2000" })).toBe(true);
  });

  it("date range uses string compare", () => {
    const date = cols[3];
    expect(passesFilter(date, rows[0], { from: "2025-02-01" })).toBe(false);
    expect(passesFilter(date, rows[1], { from: "2025-02-01", to: "2025-04-01" })).toBe(true);
  });

  it("global search matches across search keys", () => {
    expect(applyFilters(rows, cols, {}, "hab", searchKeys).map((r) => r.name)).toEqual(["Bella", "Dov"]);
  });

  it("sort cycles asc → desc → none", () => {
    let s = toggleSortState([], "gross", false);
    expect(s).toEqual([{ key: "gross", dir: "asc" }]);
    s = toggleSortState(s, "gross", false);
    expect(s).toEqual([{ key: "gross", dir: "desc" }]);
    s = toggleSortState(s, "gross", false);
    expect(s).toEqual([]);
  });

  it("shift-sort adds and updates levels", () => {
    let s = toggleSortState([{ key: "program", dir: "asc" }], "name", true);
    expect(s).toEqual([{ key: "program", dir: "asc" }, { key: "name", dir: "asc" }]);
    s = toggleSortState(s, "name", true);
    expect(s.find((k) => k.key === "name")!.dir).toBe("desc");
    s = toggleSortState(s, "name", true);
    expect(s.map((k) => k.key)).toEqual(["program"]);
  });

  it("numeric sort orders by value, nulls first ascending", () => {
    const out = sortRows(rows, cols, [{ key: "gross", dir: "asc" }]);
    expect(out.map((r) => r.name)).toEqual(["Cara", "Aaron", "Bella", "Dov"]);
  });

  it("value counts exclude the column's own filter but honor others", () => {
    const counts = valueCountsFor(cols, rows, { program: { selected: ["Respite"] } }, "", searchKeys, "program");
    // own filter excluded → all programs counted
    expect(counts).toEqual([
      ["Com Hab", 1],
      ["Day Hab", 1],
      ["Respite", 2],
    ]);
  });

  it("filterActive and anyFilterActive detect state", () => {
    expect(filterActive(cols[2], { min: "10" })).toBe(true);
    expect(filterActive(cols[2], {})).toBe(false);
    expect(anyFilterActive(cols, {}, "")).toBe(false);
    expect(anyFilterActive(cols, {}, "x")).toBe(true);
    expect(anyFilterActive(cols, { gross: { min: "1" } }, "")).toBe(true);
  });

  it("filter chips summarize each active filter", () => {
    const chips = filterChips(cols, {
      program: { selected: ["Respite", "Com Hab"] },
      gross: { min: "100", max: "500" },
      date: { from: "2025-01-01" },
    });
    const byKey = Object.fromEntries(chips.map((c) => [c.key, c.label]));
    expect(byKey.program).toContain("Respite");
    expect(byKey.gross).toContain("100");
    expect(byKey.gross).toContain("500");
    expect(byKey.date).toContain("2025-01-01");
  });

  it("formatCell renders money/hours/percent/empty", () => {
    expect(formatCell(cols[2], rows[0])).toBe("$100.00");
    expect(formatCell({ key: "u", label: "U", kind: "percent", accessor: () => "42", percentPlaces: 1 } as ColumnDef<Row>, rows[0])).toBe("42%");
    expect(formatCell({ key: "g", label: "G", kind: "money", accessor: () => null, emptyText: "—" } as ColumnDef<Row>, rows[0])).toBe("—");
  });

  it("export payload maps columns and rows", () => {
    const ec = exportColumns(cols);
    expect(ec[0]).toEqual({ key: "name", header: "Name", type: "text" });
    expect(ec[2]).toEqual({ key: "gross", header: "Gross", type: "money" });
    const er = exportRows(cols, [rows[0]]);
    expect(er[0]).toEqual({ name: "Aaron", program: "Respite", gross: "100.00", date: "2025-01-01" });
  });
});

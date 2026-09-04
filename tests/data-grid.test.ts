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
  dateBucket,
  filterKey,
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

  it("keeps private sort keys out of exported cells", () => {
    const honest: ColumnDef<Row> = {
      key: "name",
      label: "Name",
      kind: "text",
      accessor: (row) => row.name,
      sortAccessor: (row) => row.name === "Aaron" ? "99" : "01",
      exportAccessor: (row) => `Person: ${row.name}`,
    };
    expect(sortRows(rows.slice(0, 2), [honest], [{ key: "name", dir: "asc" }]).map((row) => row.name))
      .toEqual(["Bella", "Aaron"]);
    expect(exportRows([honest], [rows[0]])).toEqual([{ name: "Person: Aaron" }]);
  });
});

/* ---- Google-Sheets-style value selection for dates and numbers ---- */

interface DRow {
  date: string;
  rate: string;
}
const dcols: ColumnDef<DRow>[] = [
  { key: "date", label: "Check date", kind: "date", accessor: (r) => r.date },
  { key: "rate", label: "Rate", kind: "money", accessor: (r) => r.rate },
];
const drows: DRow[] = [
  { date: "2025-06-15", rate: "21" },
  { date: "2025-12-31", rate: "25.0000" },
  { date: "2026-01-10", rate: "21" },
  { date: "2026-08-18", rate: "17" },
  { date: "2026-08-02", rate: "25" },
];

describe("date & number value pickers", () => {
  it("buckets ISO dates by day/month/year", () => {
    expect(dateBucket("2026-08-18", "day")).toBe("2026-08-18");
    expect(dateBucket("2026-08-18", "month")).toBe("2026-08");
    expect(dateBucket("2026-08-18", "year")).toBe("2026");
    expect(dateBucket("", "year")).toBe("");
  });

  it("filterKey canonicalizes numbers and buckets dates", () => {
    expect(filterKey(dcols[1], drows[1])).toBe("25"); // "25.0000" -> "25"
    expect(filterKey(dcols[0], drows[3], "month")).toBe("2026-08");
    expect(filterKey(dcols[0], drows[3], "year")).toBe("2026");
  });

  it("selecting a year keeps every date in that year", () => {
    const f = { date: { selected: ["2026"], dateGroup: "year" as const } };
    const out = applyFilters(drows, dcols, f, "", []);
    expect(out.map((r) => r.date)).toEqual(["2026-01-10", "2026-08-18", "2026-08-02"]);
  });

  it("deselecting a year (selecting the others) drops it", () => {
    // "select 2025, deselect 2026" -> only 2025 rows remain
    const f = { date: { selected: ["2025"], dateGroup: "year" as const } };
    const out = applyFilters(drows, dcols, f, "", []);
    expect(out.map((r) => r.date)).toEqual(["2025-06-15", "2025-12-31"]);
  });

  it("selecting a month keeps only that month", () => {
    const f = { date: { selected: ["2026-08"], dateGroup: "month" as const } };
    const out = applyFilters(drows, dcols, f, "", []);
    expect(out.map((r) => r.date)).toEqual(["2026-08-18", "2026-08-02"]);
  });

  it("number value selection matches canonical values regardless of trailing zeros", () => {
    const f = { rate: { selected: ["25"] } };
    const out = applyFilters(drows, dcols, f, "", []);
    expect(out.map((r) => r.date)).toEqual(["2025-12-31", "2026-08-02"]);
  });

  it("selected value-set AND range both apply to a number column", () => {
    // pick rates {21,25} then also require >= 22 -> only 25 survives
    const f = { rate: { selected: ["21", "25"], min: "22" } };
    const out = applyFilters(drows, dcols, f, "", []);
    expect(out.map((r) => r.rate)).toEqual(["25.0000", "25"]);
  });

  it("value counts bucket dates by the column's dateGroup, newest first", () => {
    const counts = valueCountsFor(dcols, drows, { date: { dateGroup: "year" } }, "", [], "date");
    expect(counts).toEqual([
      ["2026", 3],
      ["2025", 2],
    ]);
  });

  it("value counts collapse number trailing zeros, ascending", () => {
    const counts = valueCountsFor(dcols, drows, {}, "", [], "rate");
    expect(counts).toEqual([
      ["17", 1],
      ["21", 2],
      ["25", 2],
    ]);
  });

  it("filterActive treats a present selection as active for dates and numbers", () => {
    expect(filterActive(dcols[0], { selected: ["2026"], dateGroup: "year" })).toBe(true);
    expect(filterActive(dcols[0], { selected: [] })).toBe(true); // empty = show none
    expect(filterActive(dcols[1], { selected: ["21"] })).toBe(true);
    expect(filterActive(dcols[0], {})).toBe(false);
  });

  it("chips summarize a date value selection", () => {
    const chips = filterChips(dcols, { date: { selected: ["2026"], dateGroup: "year" } });
    expect(chips[0].label).toContain("2026");
  });
});

import { describe, it, expect } from "vitest";
import { parseCsv, parseSheetCsv } from "@/lib/sheets/parse-csv";

/** Encode a grid as CSV, quoting every field (mirrors Google's gviz export). */
function toCsv(grid: string[][]): string {
  return grid.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
}

/** A sparse header exactly like the live sheet: only five labels are present. */
function header(): string[] {
  const h = new Array(20).fill("");
  h[0] = "Pay to";
  h[3] = "Code";
  h[10] = "Paid CC2 Description";
  h[11] = "Paid CC3 Description";
  h[12] = "Employee Memo";
  return h;
}

function totalsRow(internal: string, gross: string, retention: string, net: string): string[] {
  const r = new Array(20).fill("");
  r[15] = internal; // P
  r[16] = gross; // Q
  r[17] = retention; // R
  r[18] = net; // S
  return r;
}

function dataRow(o: {
  payTo?: string; checkDate?: string; checkNumber?: string; hours: string; rate: string;
  amount: string; totalNetPay?: string; periodBegin?: string; periodEnd?: string;
  program: string; individual: string; employee?: string; internal?: string;
}): string[] {
  const r = new Array(20).fill("");
  r[0] = o.payTo ?? "Excellent Staffing";
  r[1] = o.checkDate ?? "05/25/2023";
  r[2] = o.checkNumber ?? "12433";
  r[4] = o.hours;
  r[5] = o.rate;
  r[6] = o.amount;
  r[7] = o.totalNetPay ?? "";
  r[8] = o.periodBegin ?? "05/01/2023";
  r[9] = o.periodEnd ?? "05/15/2023";
  r[10] = o.program;
  r[11] = o.individual;
  r[12] = o.employee ?? "Grosz, Moshe";
  r[15] = o.internal ?? "";
  return r;
}

describe("CSV reader", () => {
  it("parses quoted fields, embedded commas and escaped quotes", () => {
    const grid = parseCsv('"a","b,c","d""e"\n"1","2","3"');
    expect(grid).toEqual([
      ["a", "b,c", 'd"e'],
      ["1", "2", "3"],
    ]);
  });

  it("handles \\r\\n line endings and a final unterminated row", () => {
    const grid = parseCsv('"a","b"\r\n"c","d"');
    expect(grid).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("Ahivim sheet CSV → parsed rows", () => {
  const grid = [
    totalsRow("46055.03", "53551.37", "7496.34", "29813.88"),
    header(),
    dataRow({ hours: "22.67", rate: "20.0", amount: "453.4", program: "Com Hab", individual: "Markovitz, Berl", internal: "380.856" }),
    dataRow({ hours: "1.67", rate: "45.0", amount: "75.15", program: "Day Hab", individual: "Cohen, Benjamin", employee: "Katz, Elimelech", internal: "75.15" }),
  ];

  it("maps columns by the verified positions and reads control totals", () => {
    const parse = parseSheetCsv(toCsv(grid));
    expect(parse.controlTotals).toEqual({
      internalAmount: "46055.03",
      agencyGross: "53551.37",
      agencyRetention: "7496.34",
      deduplicatedNetPay: "29813.88",
    });
    expect(parse.ahivimRows).toHaveLength(2);
    const first = parse.ahivimRows[0]!;
    expect(first.parsed).not.toBeNull();
    expect(first.parsed!.individual).toBe("Markovitz, Berl");
    expect(first.parsed!.programDescription).toBe("Com Hab");
    expect(first.parsed!.hours).toBe("22.67");
    expect(first.parsed!.amount).toBe("453.4");
    // Dates are coerced from US spelling to ISO.
    expect(first.parsed!.checkDate).toBe("2023-05-25");
    expect(first.parsed!.periodBegin).toBe("2023-05-01");
    // A CSV export never carries formulas.
    expect(first.formulas).toEqual({});
  });

  it("produces a stable snapshot hash that is order-independent but content-sensitive", () => {
    const a = parseSheetCsv(toCsv(grid));
    // Re-order the two data rows: same content, same hash.
    const reordered = [grid[0], grid[1], grid[3], grid[2]];
    const b = parseSheetCsv(toCsv(reordered));
    expect(b.snapshotSha256).toBe(a.snapshotSha256);

    // Change one amount: different hash.
    const changed = [grid[0], grid[1], grid[2], dataRow({ hours: "1.67", rate: "45.0", amount: "99.99", program: "Day Hab", individual: "Cohen, Benjamin", employee: "Katz, Elimelech" })];
    const c = parseSheetCsv(toCsv(changed));
    expect(c.snapshotSha256).not.toBe(a.snapshotSha256);
  });

  it("skips blank rows and records a validation error for an unparseable row", () => {
    const withBad = [
      grid[0],
      grid[1],
      grid[2],
      new Array(20).fill(""), // blank
      dataRow({ hours: "x", rate: "y", amount: "z", program: "", individual: "", employee: "" }), // invalid
    ];
    const parse = parseSheetCsv(toCsv(withBad));
    expect(parse.ahivimRows).toHaveLength(2); // blank dropped, one valid + one invalid
    const invalid = parse.ahivimRows.find((r) => r.parsed === null);
    expect(invalid).toBeTruthy();
    expect(invalid!.errors.length).toBeGreaterThan(0);
  });
});

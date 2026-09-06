import { describe, it, expect } from "vitest";
import {
  normalizeAccountingNumber,
  parseCsv,
  parseSheetCsv,
} from "@/lib/sheets/parse-csv";

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
    expect(parse.rawControlTotals).toEqual(parse.controlTotals);
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
    expect(parse.paidColumnFound).toBe(true);
  });

  it("uses row-1 controls only when Decimal-safe source-column totals prove whole-Sheet scope", () => {
    const wholeSheet = [
      totalsRow("456.006", "528.55", "72.544", ""),
      header(),
      grid[2]!,
      grid[3]!,
    ];

    const parse = parseSheetCsv(toCsv(wholeSheet));

    expect(parse.wholeSheetControlTotals).toEqual({
      internalAmount: "456.006",
      agencyGross: "528.55",
    });
    expect(parse.controlTotalEvidence).toEqual({
      internalAmount: {
        status: "whole_source",
        supplied: "456.006",
        rawSupplied: "456.006",
        allRowsTotal: "456.006",
      },
      agencyGross: {
        status: "whole_source",
        supplied: "528.55",
        rawSupplied: "528.55",
        allRowsTotal: "528.55",
      },
    });
  });

  it("keeps each proved whole-Sheet control independent of a partial peer", () => {
    const internalOnly = parseSheetCsv(toCsv([
      totalsRow("456.006", "453.4", "", ""),
      header(),
      grid[2]!,
      grid[3]!,
    ]));
    const grossOnly = parseSheetCsv(toCsv([
      totalsRow("380.856", "528.55", "", ""),
      header(),
      grid[2]!,
      grid[3]!,
    ]));

    expect(internalOnly.wholeSheetControlTotals).toEqual({
      internalAmount: "456.006",
      agencyGross: null,
    });
    expect(grossOnly.wholeSheetControlTotals).toEqual({
      internalAmount: null,
      agencyGross: "528.55",
    });
  });

  it("preserves filtered or partial controls for audit but does not use them as whole-Sheet controls", () => {
    const filteredControls = [
      totalsRow("380.856", "453.4", "72.544", ""),
      header(),
      grid[2]!,
      grid[3]!,
    ];

    const parse = parseSheetCsv(toCsv(filteredControls));

    expect(parse.controlTotals.internalAmount).toBe("380.856");
    expect(parse.controlTotals.agencyGross).toBe("453.4");
    expect(parse.wholeSheetControlTotals).toEqual({
      internalAmount: null,
      agencyGross: null,
    });
    expect(parse.controlTotalEvidence).toEqual({
      internalAmount: {
        status: "scoped_or_mismatched",
        supplied: "380.856",
        rawSupplied: "380.856",
        allRowsTotal: "456.006",
      },
      agencyGross: {
        status: "scoped_or_mismatched",
        supplied: "453.4",
        rawSupplied: "453.4",
        allRowsTotal: "528.55",
      },
    });
    expect(parse.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("P1 control"),
      expect.stringContaining("Q1 control"),
      expect.stringContaining("filtered or otherwise partial"),
    ]));
  });

  it("marks a nonblank nonnumeric source column unverified instead of inferring a partial total", () => {
    const unparseable = [
      totalsRow("380.856", "453.4", "72.544", ""),
      header(),
      grid[2]!,
      dataRow({
        hours: "1",
        rate: "20",
        amount: "not-money",
        program: "Com Hab",
        individual: "Unreadable Amount",
        internal: "not-money",
      }),
    ];

    const parse = parseSheetCsv(toCsv(unparseable));

    expect(parse.controlTotals.internalAmount).toBe("380.856");
    expect(parse.controlTotals.agencyGross).toBe("453.4");
    expect(parse.wholeSheetControlTotals).toEqual({
      internalAmount: null,
      agencyGross: null,
    });
    expect(parse.controlTotalEvidence.internalAmount).toEqual({
      status: "unverified",
      supplied: "380.856",
      rawSupplied: "380.856",
      allRowsTotal: null,
    });
    expect(parse.controlTotalEvidence.agencyGross).toEqual({
      status: "unverified",
      supplied: "453.4",
      rawSupplied: "453.4",
      allRowsTotal: null,
    });
    expect(parse.warnings.filter((warning) => warning.includes("nonblank, nonnumeric"))).toHaveLength(2);
  });

  it("retains a broken displayed control and independently accepts its valid peer", () => {
    const parse = parseSheetCsv(toCsv([
      totalsRow("#REF!", "528.55", "#N/A", ""),
      header(),
      grid[2]!,
      grid[3]!,
    ]));

    expect(parse.rawControlTotals).toEqual({
      internalAmount: "#REF!",
      agencyGross: "528.55",
      agencyRetention: "#N/A",
      deduplicatedNetPay: null,
    });
    expect(parse.controlTotals).toEqual({
      internalAmount: null,
      agencyGross: "528.55",
      agencyRetention: null,
      deduplicatedNetPay: null,
    });
    expect(parse.wholeSheetControlTotals).toEqual({
      internalAmount: null,
      agencyGross: "528.55",
    });
    expect(parse.controlTotalEvidence.internalAmount).toEqual({
      status: "invalid_control",
      supplied: null,
      rawSupplied: "#REF!",
      allRowsTotal: "456.006",
    });
    expect(parse.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("#REF!"),
      expect.stringContaining("preserved for audit"),
    ]));
  });

  it("recognizes the blank positional Paid column so clearing its final marker is observable", () => {
    const withBlankPaidColumn = parseSheetCsv(toCsv(grid));
    const paidRow = [...grid[2]!];
    paidRow[13] = "Paid";
    const withOnePaidMarker = parseSheetCsv(toCsv([grid[0]!, grid[1]!, paidRow, grid[3]!]));
    const physicallyShort = parseSheetCsv(toCsv([
      header().slice(0, 13),
      dataRow({ hours: "1", rate: "25", amount: "25", program: "Com Hab", individual: "Test Person" }).slice(0, 13),
    ]));

    expect(withBlankPaidColumn.ahivimRows.every((row) => row.raw.paid === "")).toBe(true);
    expect(withBlankPaidColumn.paidColumnFound).toBe(true);
    expect(withOnePaidMarker.snapshotSha256).not.toBe(withBlankPaidColumn.snapshotSha256);
    expect(physicallyShort.paidColumnFound).toBe(false);
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

  it("normalizes accounting-style negatives without changing the raw source cell", () => {
    const accounting = [
      grid[0],
      grid[1],
      dataRow({
        hours: "-31.25",
        rate: "20",
        amount: "$ (625.00)",
        program: "Com Hab",
        individual: "Markovitz, Berl",
        employee: "Denied Billing",
        internal: "$(531.25)",
      }),
    ];

    const parse = parseSheetCsv(toCsv(accounting));
    const row = parse.ahivimRows[0]!;

    expect(row.parsed).not.toBeNull();
    expect(row.parsed!.amount).toBe("-625.00");
    expect(row.parsed!.calculatedInternalAmount).toBe("-531.25");
    expect(row.raw.amount).toBe("$ (625.00)");
    expect(row.raw.calculatedInternalAmount).toBe("$(531.25)");
  });

  it("leaves ordinary and malformed numeric text unchanged", () => {
    expect(normalizeAccountingNumber(" $1,234.50 ")).toBe("$1,234.50");
    expect(normalizeAccountingNumber("(not a number)")).toBe("(not a number)");
    expect(normalizeAccountingNumber("(1,234.50)")).toBe("-1234.50");
  });

  it("makes accounting-negative control totals safe for Decimal reconciliation", () => {
    const accountingTotals = [
      totalsRow("$ (531.25)", "$ (625.00)", "93.75", "(600.00)"),
      header(),
      grid[2],
    ];
    const parsed = parseSheetCsv(toCsv(accountingTotals));
    expect(parsed.rawControlTotals).toEqual({
      internalAmount: "$ (531.25)",
      agencyGross: "$ (625.00)",
      agencyRetention: "93.75",
      deduplicatedNetPay: "(600.00)",
    });
    expect(parsed.controlTotals).toEqual({
      internalAmount: "-531.25",
      agencyGross: "-625.00",
      agencyRetention: "93.75",
      deduplicatedNetPay: "-600.00",
    });
  });
});

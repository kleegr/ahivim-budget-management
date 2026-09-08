import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { DEFAULT_SHEET_GID, DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { fetchSheetCsv, sheetValuesToCsv } from "@/lib/sheets/fetch";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { recoverNumericSourceCsv, restoreSheetDateColumns } from "@/lib/sheets/numeric-source";
import { numericSheetFixture } from "./support/sheet-numeric-fixture";

describe("unformatted numeric Sheet evidence", () => {
  it("normalizes only actual date columns and preserves fractional NET and physical rows", async () => {
    const fixture = await numericSheetFixture();
    const serial = (date: string) => Date.parse(date) / 86_400_000 + 25_569;
    const values: unknown[][] = fixture.values.map((row) => [...row]);
    values[3]![1] = serial("2026-08-21"); values[3]![8] = serial("2026-08-01");
    values[3]![9] = serial("2026-08-15"); values[3]![7] = 3172.03;
    const parsed = parseSheetCsv(sheetValuesToCsv(restoreSheetDateColumns(values)));
    expect(parsed.ahivimRows[0]).toMatchObject({ sourceRowNumber: 4, parsed: {
      checkDate: "2026-08-21", periodBegin: "2026-08-01", periodEnd: "2026-08-15", totalNetPay: "3172.03",
    } });
    expect(parsed.ahivimRows[1]?.raw.totalNetPay).toBe("Review original check");
    expect(parsed.ahivimRows[1]?.parsed?.totalNetPay).toBe("");
  });

  it("recovers exact cached NET via the same pinned tab, keeps zero and unknown facts, and reads only", async () => {
    const fixture = await numericSheetFixture();
    const zip = await JSZip.loadAsync(fixture.bytes);
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toMatch(/<c\b[^>]*\br="O4"[^>]*\/>/);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(fixture.csv))
      .mockResolvedValueOnce(new Response(new Uint8Array(fixture.bytes)));
    const csv = await fetchSheetCsv(DEFAULT_SYNC_CONFIG, { credentials: null, request });
    const parsed = parseSheetCsv(csv);
    expect(parsed.ahivimRows.map((row) => row.sourceRowNumber)).toEqual([4, 5]);
    expect(parsed.ahivimRows[0]?.parsed).toMatchObject({ totalNetPay: "3172.03", calculatedInternalAmount: "0", nonContractHeader: "" });
    expect(parsed.ahivimRows[1]?.parsed?.totalNetPay).toBe("");
    expect(parsed.ahivimRows[1]?.raw.totalNetPay).toBe("Review original check");
    expect(request).toHaveBeenCalledTimes(2);
    for (const [url, options] of request.mock.calls) {
      expect(new URL(String(url)).pathname).toContain(DEFAULT_SYNC_CONFIG.sheetId);
      expect(new URL(String(url)).searchParams.get("gid")).toBe(DEFAULT_SHEET_GID);
      expect(options).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" });
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
    expect(new URL(String(request.mock.calls[1]![0])).searchParams.get("format")).toBe("xlsx");
  });

  it("keeps a real text date in a numeric column unknown instead of interpreting it as money", async () => {
    const fixture = await numericSheetFixture({ editWorkbook: (sheet) => { sheet.getCell("H4").value = "9/6/1908"; } });
    const parsed = parseSheetCsv(await recoverNumericSourceCsv(fixture.csv, fixture.bytes, "Ahivim"));
    expect(parsed.ahivimRows[0]?.raw.totalNetPay).toBe("9/6/1908");
    expect(parsed.ahivimRows[0]?.parsed?.totalNetPay).toBe("");
  });

  it.each([0, 3172.03125])("preserves the raw numeric cache %s without rounding or evaluating formulas", async (value) => {
    const fixture = await numericSheetFixture({ editWorkbook: (sheet) => { sheet.getCell("H4").value = value; } });
    const parsed = parseSheetCsv(await recoverNumericSourceCsv(fixture.csv, fixture.bytes, "Ahivim"));
    expect(parsed.ahivimRows[0]?.parsed?.totalNetPay).toBe(String(value));
  });

  it("rejects a missing numeric cache rather than evaluating a formula", async () => {
    const fixture = await numericSheetFixture({ editWorkbook: (sheet) => { sheet.getCell("H4").value = { formula: "3172.03" }; } });
    await expect(recoverNumericSourceCsv(fixture.csv, fixture.bytes, "Ahivim")).rejects.toThrow("changed between source reads");
  });

  it.each([
    { name: "billed amount", address: "G4", value: 3800.01 },
    { name: "sub-cent billed amount", address: "G4", value: 3800.00001 },
    { name: "employee", address: "M4", value: "Changed source employee" },
    { name: "Paid evidence", address: "N4", value: "Paid" },
    { name: "explicit zero", address: "P5", value: null },
  ])("rejects $name drift between the CSV and numeric source", async ({ address, value }) => {
    const fixture = await numericSheetFixture({ editWorkbook: (sheet) => { sheet.getCell(address).value = value; } });
    await expect(recoverNumericSourceCsv(fixture.csv, fixture.bytes, "Ahivim")).rejects.toThrow("changed between source reads");
  });

  it("rejects another tab or a truncated snapshot", async () => {
    const wrong = await numericSheetFixture({ sheetName: "Other payroll" });
    await expect(recoverNumericSourceCsv(wrong.csv, wrong.bytes, "Ahivim")).rejects.toThrow("pinned transaction tab");
    const partial = await numericSheetFixture({ editWorkbook: (sheet) => { sheet.spliceRows(5, 1); } });
    await expect(recoverNumericSourceCsv(partial.csv, partial.bytes, "Ahivim")).rejects.toThrow("row layout");
  });

  it("fails before importing if the pinned numeric read is unavailable", async () => {
    const fixture = await numericSheetFixture();
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(fixture.csv))
      .mockResolvedValueOnce(new Response("private diagnostic", { status: 403 }));
    await expect(fetchSheetCsv(DEFAULT_SYNC_CONFIG, { credentials: null, request })).rejects.toThrow("Nothing was imported");
  });
});

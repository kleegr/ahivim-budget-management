import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizePersonName } from "@/lib/business/name-matching";
import { parseCalculationsWorkbook } from "@/lib/excel/parse-calculations-workbook";
import { reconcileCalculationWorkbook } from "@/lib/import/calculation-workbook";
import type { PgLikePool } from "@/lib/import/commit";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
let pool: PgLikePool;

function headers(sheet: ExcelJS.Worksheet): void {
  const labels: Record<number, string> = {
    5: "1st %", 6: "2nd %", 7: "Clock", 8: "Adjustments",
    9: "ComHab", 10: "Respite", 11: "SHCH", 12: "SHR", 13: "DayHab", 14: "SDH",
    16: "Yearly Gross", 17: "Monthly Gross", 18: "Gross Net", 19: "Net", 20: "After All",
  };
  for (const [column, label] of Object.entries(labels)) {
    sheet.getRow(1).getCell(Number(column)).value = label;
  }
  sheet.getCell("C2").value = "Rates";
  [21, 17, 38, 18, 17, 17].forEach((rate, index) => {
    sheet.getRow(2).getCell(9 + index).value = rate;
  });
}

function calculationRow(sheet: ExcelJS.Worksheet, row: number, name: string): void {
  sheet.getRow(row).getCell(3).value = name;
  sheet.getRow(row).getCell(4).value = new Date(Date.UTC(2027, 0, 1));
  sheet.getRow(row).getCell(5).value = 10;
  sheet.getRow(row).getCell(6).value = 20;
  sheet.getRow(row).getCell(7).value = -5;
  sheet.getRow(row).getCell(8).value = 10;
  sheet.getRow(row).getCell(9).value = 100;
  sheet.getRow(row).getCell(16).value = { formula: `I${row}*I$2`, result: 2100 };
  sheet.getRow(row).getCell(17).value = { formula: `P${row}/12`, result: 175 };
  sheet.getRow(row).getCell(18).value = {
    formula: `Q${row}-(Q${row}*E${row}/100)-((Q${row}-(Q${row}*E${row}/100))*F${row}/100)`,
    result: 126,
  };
  sheet.getRow(row).getCell(19).value = { formula: `SUM(R${row},G${row}:H${row})`, result: 131 };
  sheet.getRow(row).getCell(20).value = 130;
  sheet.getRow(row).getCell(21).value = "C";
  sheet.getRow(row).getCell(22).value = "Approved source note";
  sheet.getRow(row).getCell(23).value = "845-555-0100";
}

async function sourceWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ahivim");
  headers(sheet);
  calculationRow(sheet, 5, "Taylor Sample (Sep 1)");
  calculationRow(sheet, 6, "Unknown Person");
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

suite("Calculations workbook import (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(`DELETE FROM calculation_strategy_import_rows`);
  });
  afterAll(closeTestPool);

  it("inserts only an unequivocally missing strategy and is repeat-safe", async () => {
    const person = await pool.query<{ id: string }>(
      `INSERT INTO individuals (display_name, normalized_name)
       VALUES ($1, $2) RETURNING id`,
      ["Sample, Taylor", normalizePersonName("Sample, Taylor")],
    );
    const parsed = await parseCalculationsWorkbook(await sourceWorkbook(), "calculations.xlsx");

    const dryRun = await reconcileCalculationWorkbook(pool, parsed, {
      asOf: "2026-09-04",
    });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.summary).toMatchObject({ missing: 1, ambiguous: 1, insertedStrategies: 0 });
    expect(dryRun.rows.find((row) => row.sourceRowNumber === 5)).toMatchObject({
      individualId: person.rows[0]!.id,
      identityMatch: "exact",
      classification: "missing",
      safeToApply: true,
    });

    const applied = await reconcileCalculationWorkbook(pool, parsed, {
      apply: true,
      asOf: "2026-09-04",
    });
    expect(applied.summary).toMatchObject({ insertedStrategies: 1, recordedSourceRows: 2 });
    expect(applied.rows.find((row) => row.sourceRowNumber === 5)?.applied).toBe(true);
    expect(applied.rows.find((row) => row.sourceRowNumber === 6)?.classification).toBe("ambiguous");

    const stored = await pool.query<{
      strategies: string;
      lines: string;
      provenance: string;
      after_all: string;
      notes: string;
      phone: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM calculation_strategies) AS strategies,
         (SELECT count(*)::text FROM calculation_strategy_lines) AS lines,
         (SELECT count(*)::text FROM calculation_strategy_import_rows) AS provenance,
         (SELECT after_all::text FROM calculation_strategies LIMIT 1) AS after_all,
         (SELECT notes FROM calculation_strategies LIMIT 1) AS notes,
         (SELECT phone FROM individuals WHERE id = $1) AS phone`,
      [person.rows[0]!.id],
    );
    expect(stored.rows[0]).toMatchObject({
      strategies: "1",
      lines: "1",
      provenance: "2",
      after_all: "130.0000",
      notes: "Approved source note",
      phone: "845-555-0100",
    });

    const repeated = await reconcileCalculationWorkbook(pool, parsed, {
      apply: true,
      asOf: "2026-09-04",
    });
    expect(repeated.summary).toMatchObject({ exact: 1, insertedStrategies: 0, recordedSourceRows: 0 });
    expect(await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM calculation_strategies`,
    )).toMatchObject({ rows: [{ count: "1" }] });

    await pool.query(`UPDATE calculation_strategies SET after_all = 999`);
    const changed = await reconcileCalculationWorkbook(pool, parsed, {
      apply: true,
      asOf: "2026-09-04",
    });
    expect(changed.rows.find((row) => row.sourceRowNumber === 5)?.classification).toBe("different");
    expect(changed.summary.insertedStrategies).toBe(0);
    const preserved = await pool.query<{ after_all: string }>(
      `SELECT after_all::text FROM calculation_strategies`,
    );
    expect(preserved.rows[0]!.after_all).toBe("999.0000");
  });
});

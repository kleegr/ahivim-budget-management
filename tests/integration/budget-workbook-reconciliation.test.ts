import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { normalizePersonName } from "@/lib/business/name-matching";
import {
  BUDGET_WORKBOOK_PROGRAM_COLUMNS,
  parseBudgetWorkbook,
} from "@/lib/excel/parse-budget-workbook";
import type { PgLikePool } from "@/lib/import/commit";
import { reconcileBudgetWorkbook } from "@/lib/import/budget-workbook";
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
  sheet.getCell("A1").value = "Individual";
  sheet.getCell("B1").value = "Renewal Date";
  for (const spec of BUDGET_WORKBOOK_PROGRAM_COLUMNS) {
    sheet.getRow(1).getCell(spec.originalColumn).value = spec.programCode === "SH_COM_HAB"
      ? "SD - Self Hired Com Hab"
      : spec.programCode === "SH_RESPITE"
        ? "SD - Self Hired Respite"
        : spec.programLabel;
    sheet.getRow(2).getCell(spec.originalColumn).value = "original";
    sheet.getRow(2).getCell(spec.billedColumn).value = "Billed";
  }
}

async function sourceWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("UpToDate");
  headers(sheet);
  sheet.getCell("A3").value = "Budget, Person";
  sheet.getCell("B3").value = new Date(Date.UTC(2027, 0, 1));
  sheet.getCell("D3").value = 416;
  sheet.getCell("F3").value = { formula: "35+0.91", result: 35.91 };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

suite("Budget workbook recovery (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO individuals (normalized_name, display_name)
       VALUES ($1, 'Budget Person')`,
      [normalizePersonName("Budget, Person")],
    );
  });

  afterAll(closeTestPool);

  it("dry-runs, applies only Original hours with provenance, and retries as a zero-write no-op", async () => {
    const parsed = await parseBudgetWorkbook(await sourceWorkbook(), "Budget source.xlsx");
    const dryRun = await reconcileBudgetWorkbook(pool, parsed, { asOfDate: "2026-09-04" });
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      summary: { applicablePeriods: 1, applicableAuthorizations: 1 },
    });
    expect(dryRun.rows[0]?.authorizations.find((authorization) => authorization.programCode === "RESPITE"))
      .toMatchObject({
        sourceAuthorizedHours: null,
        comparisonBilledHours: "35.91",
        state: "needs_owner_review",
        canApply: false,
      });

    const applied = await reconcileBudgetWorkbook(pool, parsed, {
      apply: true,
      asOfDate: "2026-09-04",
    });
    expect(applied.applySummary).toMatchObject({
      insertedPeriods: 1,
      insertedAuthorizations: 1,
      concurrentExactNoops: 0,
    });
    expect(applied.summary).toMatchObject({ applicablePeriods: 0, applicableAuthorizations: 0 });

    const stored = await pool.query<{
      authorized_hours: string;
      source: string;
      source_row_ref: string;
    }>(
      `SELECT authorized_hours::text, source, source_row_ref
         FROM budget_authorizations`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      authorized_hours: "416.0000",
      source: "budget_workbook",
    });
    expect(stored.rows[0]?.source_row_ref).toContain("Budget source.xlsx::UpToDate::row=3::cell=D3::sha256=");
    expect(await pool.query(`SELECT 1 FROM budget_authorizations WHERE authorized_hours = 35.91`))
      .toMatchObject({ rows: [] });

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE action IN ('budget_period_created', 'authorization_created')
        ORDER BY action`,
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "authorization_created",
      "budget_period_created",
    ]);

    const retry = await reconcileBudgetWorkbook(pool, parsed, {
      apply: true,
      asOfDate: "2026-09-04",
    });
    expect(retry.applySummary).toMatchObject({
      insertedPeriods: 0,
      insertedAuthorizations: 0,
      concurrentExactNoops: 0,
    });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM budget_periods`,
    )).rows[0]?.count).toBe("1");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM budget_authorizations`,
    )).rows[0]?.count).toBe("1");
  });
});

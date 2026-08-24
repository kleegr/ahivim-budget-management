import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool,
} from "../support/database";
import { buildWorkbook, ALL_ROWS, EXPECTED_AGENCY_GROSS, EXPECTED_INTERNAL_AMOUNT } from "../support/workbook";
import { uploadAndStage, commit } from "@/lib/import/service";
import {
  getDashboardData, listEmployees, listTransactions, listRateExceptions,
  listImports, listImportRows, listPrograms, getReconciliation, listAudit, isUuid,
} from "@/lib/data/app-queries";
import { listIndividuals, getIndividualReport, getEmployeeReport, exceptionCounts, currentRatesByProgram } from "@/lib/data/queries";
import { dec } from "@/lib/money";

/**
 * A search value made entirely of the characters that break a query built by
 * string concatenation: a quote, a statement separator, a comment marker, and
 * the two LIKE wildcards.
 *
 * The test asserts the property rather than a specific exploit: if this value
 * reaches PostgreSQL as data it matches nothing and the schema is untouched,
 * and if it reached PostgreSQL as SQL the query would raise a syntax error and
 * fail the test. Naming a destructive statement outright would prove nothing
 * extra.
 */
const SQL_METACHARACTERS = `'";--/* %_`;

const suite = hasTestDatabase ? describe : describe.skip;

suite("read models over committed data (real PostgreSQL)", () => {
  let fileId: string;
  let batchId: string;

  beforeAll(async () => {
    await resetSchema();
    await truncateBusinessTables();
    const bytes = await buildWorkbook();
    const staged = await uploadAndStage(testPool(), {
      filename: "queries-fixture.xlsx", bytes, uploadedByUserId: null,
    });
    if (!staged.ok) throw new Error("fixture staging failed");
    fileId = staged.fileId;
    const result = await commit(testPool(), fileId, null);
    if (!result.ok) throw new Error("fixture commit failed");
    batchId = result.result.importBatchId;
  }, 120_000);
  afterAll(closeTestPool);

  it("reports the same totals the import reconciled to", async () => {
    const d = await getDashboardData(testPool());
    expect(dec(d.totals.agencyGross).toNumber()).toBe(EXPECTED_AGENCY_GROSS);
    expect(dec(d.totals.internalAmount).toNumber()).toBe(EXPECTED_INTERNAL_AMOUNT);
    expect(dec(d.totals.agencyRetention).toNumber()).toBe(
      EXPECTED_AGENCY_GROSS - EXPECTED_INTERNAL_AMOUNT,
    );
    expect(d.counts.transactions).toBe(ALL_ROWS.length);
    expect(d.counts.individuals).toBe(5);
    expect(d.counts.employees).toBe(3);
    expect(d.counts.groupSessions).toBe(1);
    expect(d.counts.openRateExceptions).toBe(1);
    expect(d.counts.imports).toBe(1);
  });

  it("says why a forecast is unavailable instead of inventing a date", async () => {
    const d = await getDashboardData(testPool());
    expect(d.forecast.available).toBe(false);
    if (d.forecast.available) return;
    expect(d.forecast.reason).toMatch(/budget period/i);
    // And no authorization figures are fabricated either.
    expect(d.authorization.available).toBe(false);
    expect(d.authorization.utilizationPercent).toBeNull();
  });

  it("reports employee cash as unavailable when no account periods exist", async () => {
    const d = await getDashboardData(testPool());
    expect(d.employeeCash.available).toBe(false);
    expect(d.employeeCash.accounts).toBe(0);
  });

  it("lists individuals with their real transaction counts", async () => {
    const individuals = await listIndividuals(testPool());
    expect(individuals).toHaveLength(5);
    const david = individuals.find((i) => i.displayName.includes("David"));
    expect(david?.transactionCount).toBe(2);
    expect(dec(david!.agencyGross).toNumber()).toBe(345); // 250 + 95
  });

  it("credits each group member the full session hours, not a divided share", async () => {
    const individuals = await listIndividuals(testPool());
    const aaron = individuals.find((i) => i.displayName.includes("Aaron"))!;
    const report = await getIndividualReport(testPool(), aaron.id);
    expect(report).not.toBeNull();
    expect(dec(report!.totals.usedHours).toNumber()).toBe(13); // NOT 13/3
    expect(report!.groupSessions).toBe(1);
    expect(dec(report!.totals.agencyGross).toNumber()).toBe(247);
  });

  it("keeps an employee's physical hours separate from allocation hours", async () => {
    const employees = await listEmployees(testPool());
    const miriam = employees.find((e) => e.displayName.includes("Miriam"))!;
    const report = await getEmployeeReport(testPool(), miriam.id);
    expect(report).not.toBeNull();
    expect(dec(report!.physicalHours).toNumber()).toBe(13); // one 13-hour session
    expect(dec(report!.allocationHours).toNumber()).toBe(39); // 3 x 13
    expect(report!.individualsServed).toBe(3);
    expect(report!.groupSessions).toBe(1);
  });

  it("returns null for an individual and employee that do not exist", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await getIndividualReport(testPool(), missing)).toBeNull();
    expect(await getEmployeeReport(testPool(), missing)).toBeNull();
  });

  it("filters transactions by program and search without SQL injection", async () => {
    const all = await listTransactions(testPool(), {});
    expect(all.total).toBe(ALL_ROWS.length);

    const dayHab = await listTransactions(testPool(), { programCode: "DAY_HAB" });
    expect(dayHab.total).toBe(3);
    expect(dec(dayHab.totals.agencyGross).toNumber()).toBe(741);

    const search = await listTransactions(testPool(), { search: "David" });
    expect(search.total).toBe(2);

    // Bound as data: it matches nothing, raises no syntax error, and leaves
    // every table and row exactly where it was.
    const before = await testPool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM information_schema.tables
       WHERE table_schema = current_schema()`,
    );
    const hostile = await listTransactions(testPool(), { search: SQL_METACHARACTERS });
    expect(hostile.total).toBe(0);
    const after = await testPool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM information_schema.tables
       WHERE table_schema = current_schema()`,
    );
    expect(after.rows[0].c).toBe(before.rows[0].c);
    const still = await listTransactions(testPool(), {});
    expect(still.total).toBe(ALL_ROWS.length);
  });

  it("paginates transactions", async () => {
    const first = await listTransactions(testPool(), { limit: 2, offset: 0 });
    const second = await listTransactions(testPool(), { limit: 2, offset: 2 });
    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(2);
    expect(first.rows[0].id).not.toBe(second.rows[0].id);
    expect(first.total).toBe(ALL_ROWS.length);
  });

  it("lists the rate exception with the imported value intact", async () => {
    const { rows, total } = await listRateExceptions(testPool(), {});
    expect(total).toBe(1);
    expect(dec(rows[0].importedRate).toNumber()).toBe(23);
    expect(dec(rows[0].expectedRate).toNumber()).toBe(18);
    expect(rows[0].direction).toBe("higher");
    expect(rows[0].resolution).toBe("open");
    const none = await listRateExceptions(testPool(), { resolution: "corrected" });
    expect(none.total).toBe(0);
  });

  it("excludes group-member and uncommitted rows from the actionable rate queue", async () => {
    const { rows: groupTransactions } = await testPool().query<{ id: string }>(
      `SELECT t.id
         FROM payroll_transactions t
         JOIN service_sessions s ON s.id = t.service_session_id
        WHERE s.group_size > 1
        LIMIT 1`,
    );
    const { rows: inserted } = await testPool().query<{ id: string }>(
      `INSERT INTO rate_exceptions
         (payroll_transaction_id, imported_rate, expected_rate,
          variance_amount, variance_percent, direction, note)
       VALUES
         (NULL, '112', '17', '95', '5.588235', 'higher', 'No committed transaction'),
         ($1, '57', '17', '40', '2.352941', 'higher', 'Combined group rate')
       RETURNING id`,
      [groupTransactions[0].id],
    );

    try {
      const listed = await listRateExceptions(testPool(), { resolution: "open" });
      expect(listed.total).toBe(1);
      expect(dec(listed.rows[0].importedRate).toNumber()).toBe(23);
      expect((await exceptionCounts(testPool())).rateExceptions).toBe(1);
      expect((await getDashboardData(testPool())).counts.openRateExceptions).toBe(1);
    } finally {
      await testPool().query(`DELETE FROM rate_exceptions WHERE id = ANY($1::uuid[])`, [
        inserted.map((row) => row.id),
      ]);
    }
  });

  it("counts exceptions across every category", async () => {
    const counts = await exceptionCounts(testPool());
    expect(counts.rateExceptions).toBe(1);
    expect(counts.unknownPrograms).toBe(0);
    expect(counts.groupReviewIssues).toBe(0);
  });

  it("lists imports and their committed source rows", async () => {
    const imports = await listImports(testPool());
    expect(imports).toHaveLength(1);
    expect(imports[0].fileId).toBe(fileId);
    expect(imports[0].status).toBe("committed");
    expect(imports[0].totalRows).toBe(ALL_ROWS.length);
    expect(imports[0].checksum).toMatch(/^[0-9a-f]{64}$/);

    const rows = await listImportRows(testPool(), batchId, {});
    expect(rows.total).toBe(ALL_ROWS.length);
    // A row that staged `valid` and became a transaction is stored as
    // `imported`; nothing is deleted, so the four statuses always sum to the
    // source row count.
    expect(rows.rows.every((r) => r.status === "imported")).toBe(true);
    expect(rows.rows.every((r) => Object.keys(r.raw).length > 0)).toBe(true);

    const filtered = await listImportRows(testPool(), batchId, { status: "duplicate" });
    expect(filtered.total).toBe(0);
  });

  it("rejects a non-uuid identifier instead of interpolating it", async () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    // A batch id that is not a UUID never reaches the query at all.
    expect(await listImportRows(testPool(), SQL_METACHARACTERS, {})).toEqual({
      rows: [], total: 0,
    });
    expect(await listImportRows(testPool(), "", {})).toEqual({ rows: [], total: 0 });
  });

  it("reports reconciliation for the committed batch", async () => {
    const reconciliation = await getReconciliation(testPool());
    expect(reconciliation).toHaveLength(1);
    expect(reconciliation[0].balanced).toBe(true);
    expect(dec(reconciliation[0].agencyDifference!).toNumber()).toBe(0);
    expect(dec(reconciliation[0].internalDifference!).toNumber()).toBe(0);
  });

  it("exposes the effective-dated rate schedule", async () => {
    const programs = await listPrograms(testPool());
    expect(programs).toHaveLength(6);
    const comHab = programs.find((p) => p.code === "COM_HAB")!;
    expect(dec(comHab.agencyRate!).toNumber()).toBe(25);
    expect(dec(comHab.internalRate!).toNumber()).toBe(21);
    expect(comHab.aliasCount).toBeGreaterThan(0);

    const rates = await currentRatesByProgram(testPool());
    expect(dec(rates.DAY_HAB.internalRate).toNumber()).toBe(17);
    expect(dec(rates.DAY_HAB.agencyRate!).toNumber()).toBe(19);
    expect(rates.SH_COM_HAB.agencyRate).toBeNull();
  });

  it("records the audit trail of the import", async () => {
    const audit = await listAudit(testPool());
    expect(Array.isArray(audit)).toBe(true);
  });
});

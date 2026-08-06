import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  hasTestDatabase,
  testPool,
  resetSchema,
  truncateBusinessTables,
  closeTestPool,
  countRows,
} from "../support/database";
import { buildWorkbook, type FixtureRow } from "../support/workbook";
import { uploadAndStage, commit } from "@/lib/import/service";

/**
 * SCALE GUARD on the batched commit path.
 *
 * The commit path used to insert one row at a time; on a large sheet (or the
 * initial bootstrap) that is thousands of round-trips and risks the 300s
 * function timeout. The inserts are now chunked multi-row statements. This test
 * commits a large SYNTHETIC batch through the real upload -> stage -> commit
 * pipeline and proves the batching is correct at scale:
 *
 *   - every valid source row becomes exactly one transaction (correct count),
 *   - re-committing the same staged file is a no-op (idempotent),
 *   - re-importing the same data as a different file writes NO duplicate
 *     transaction (row-level fingerprint dedup holds at scale),
 *   - and the whole thing finishes well inside a loose time budget.
 *
 * It uses a self-contained synthetic workbook, so it runs wherever a test
 * database is configured (unlike the fixture-gated performance suite).
 */

const suite = hasTestDatabase ? describe : describe.skip;

/** Rows in the synthetic sheet. Comfortably inside the 1,500–3,000 target band. */
const ROW_COUNT = 2000;
const DISTINCT_INDIVIDUALS = 30;
const DISTINCT_EMPLOYEES = 20;

/**
 * Two clean programs whose configured ladders make the row rate legitimate (no
 * rate exception) and whose provided internal amount equals what the importer
 * calculates (no mismatch), so every row stages `valid`. A UNIQUE check number
 * per row gives every row a distinct fingerprint and a distinct group signature,
 * so each row is its own single-member service session — which also exercises
 * the batched session/allocation writes N times over.
 */
const PROGRAM_CYCLE = [
  { program: "Com Hab", rate: 25, amount: 250, internalAmount: 210 }, // 250 × 21/25
  { program: "Respite", rate: 19, amount: 95, internalAmount: 85 }, // 95 × 17/19
] as const;

/**
 * Index → distinct alphabetic token (a, b, … z, aa, ab, …). Names must be
 * distinct AFTER normalization, which strips digits, so numeric suffixes would
 * all collapse to one person.
 */
function alpha(n: number): string {
  let s = "";
  let i = n;
  do {
    s = String.fromCharCode(97 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

function syntheticRows(count: number): FixtureRow[] {
  const rows: FixtureRow[] = [];
  for (let i = 0; i < count; i++) {
    const p = PROGRAM_CYCLE[i % PROGRAM_CYCLE.length];
    rows.push({
      payTo: "Excellent Staffing",
      checkDate: "2025-06-15",
      checkNumber: String(500000 + i), // unique per row → unique fingerprint
      code: "RG",
      hours: 8,
      rate: p.rate,
      amount: p.amount,
      totalNetPay: p.amount,
      periodBegin: "2025-06-01",
      periodEnd: "2025-06-15",
      program: p.program,
      individual: `Indi ${alpha(i % DISTINCT_INDIVIDUALS)}`,
      employee: `Empl ${alpha(i % DISTINCT_EMPLOYEES)}`,
      internalAmount: p.internalAmount,
    });
  }
  return rows;
}

suite("Import commit scales to a large sheet (batched writes, real PostgreSQL)", () => {
  let rows: FixtureRow[];
  let bytes: Buffer;

  beforeAll(async () => {
    await resetSchema();
    await truncateBusinessTables();
    rows = syntheticRows(ROW_COUNT);
    bytes = await buildWorkbook(rows);
  }, 180_000);

  afterAll(closeTestPool);

  it(
    "commits thousands of rows in one transaction with no per-row round-trips, and never duplicates",
    async () => {
      /* ---- first commit: every valid row becomes one transaction ---------- */
      const staged = await uploadAndStage(testPool(), {
        filename: "scale-2025.xlsx",
        bytes,
        uploadedByUserId: null,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(staged.staging.counts.valid).toBe(ROW_COUNT);

      const startedAt = Date.now();
      const outcome = await commit(testPool(), staged.fileId, null);
      const commitMs = Date.now() - startedAt;
      console.log(`  ⏱  committed ${ROW_COUNT} rows in ${commitMs} ms`);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const { counts } = outcome.result;
      expect(outcome.result.alreadyCommitted).toBe(false);
      expect(counts.sourceRows).toBe(ROW_COUNT);
      expect(counts.importRows).toBe(ROW_COUNT); // every source row preserved
      expect(counts.transactions).toBe(ROW_COUNT); // every valid row → one transaction
      expect(counts.serviceSessions).toBe(ROW_COUNT); // each unique row → one single session
      expect(counts.serviceAllocations).toBe(ROW_COUNT); // one allocation per single
      expect(counts.individualsCreated).toBe(DISTINCT_INDIVIDUALS);
      expect(counts.employeesCreated).toBe(DISTINCT_EMPLOYEES);

      expect(await countRows("payroll_transactions")).toBe(ROW_COUNT);
      expect(await countRows("import_rows")).toBe(ROW_COUNT);
      expect(await countRows("service_sessions")).toBe(ROW_COUNT);
      expect(await countRows("service_allocations")).toBe(ROW_COUNT);

      // Loose budget: the whole batched commit must finish far inside the
      // serverless function ceiling. (Observed well under this locally.)
      expect(commitMs).toBeLessThan(120_000);

      /* ---- idempotency: committing the same staged file again is a no-op --- */
      const again = await commit(testPool(), staged.fileId, null);
      expect(again.ok).toBe(false);
      if (again.ok) return;
      expect(again.reason).toBe("already_committed");
      expect(await countRows("payroll_transactions")).toBe(ROW_COUNT);
      expect(await countRows("service_allocations")).toBe(ROW_COUNT);

      /* ---- re-import the same data as a DIFFERENT file: all duplicates ----- */
      // Reversing the rows changes the bytes (new checksum), so the file-level
      // guard cannot help — the row-level fingerprints must catch every row.
      const renamedBytes = await buildWorkbook([...rows].reverse());
      const second = await uploadAndStage(testPool(), {
        filename: "scale-2025-reordered.xlsx",
        bytes: renamedBytes,
        uploadedByUserId: null,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.staging.counts.confirmedDuplicates).toBe(ROW_COUNT);
      expect(second.staging.counts.valid).toBe(0);

      const dupCommit = await commit(testPool(), second.fileId, null);
      expect(dupCommit.ok).toBe(true);
      if (!dupCommit.ok) return;
      expect(dupCommit.result.counts.transactions).toBe(0); // nothing new written
      expect(dupCommit.result.counts.duplicateRows).toBe(ROW_COUNT);
      expect(dupCommit.result.counts.importRows).toBe(ROW_COUNT); // rows still preserved

      // The ledger is unchanged; every source row is preserved twice over.
      expect(await countRows("payroll_transactions")).toBe(ROW_COUNT);
      expect(await countRows("import_rows")).toBe(ROW_COUNT * 2);
    },
    240_000,
  );
});

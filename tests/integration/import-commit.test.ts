import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool, countRows,
} from "../support/database";
import { AGENCY_PAYEE, buildWorkbook, ALL_ROWS, EXPECTED_AGENCY_GROSS, EXPECTED_INTERNAL_AMOUNT } from "../support/workbook";
import { uploadAndStage, commit, discard, loadFile, sha256 } from "@/lib/import/service";
import { dec } from "@/lib/money";

const suite = hasTestDatabase ? describe : describe.skip;

suite("Excel import workflow end to end (real PostgreSQL)", () => {
  let bytes: Buffer;

  beforeAll(async () => {
    await resetSchema();
    bytes = await buildWorkbook();
  }, 60_000);
  beforeEach(truncateBusinessTables);
  afterAll(closeTestPool);

  async function stage() {
    const outcome = await uploadAndStage(testPool(), {
      filename: "fixture-2025.xlsx",
      bytes,
      uploadedByUserId: null,
    });
    if (!outcome.ok) throw new Error(`staging failed: ${outcome.reason} — ${outcome.message}`);
    return outcome;
  }

  /* ---------------------------------------------------------------- upload */

  it("refuses anything that is not .xlsx", async () => {
    const outcome = await uploadAndStage(testPool(), {
      filename: "payroll.csv", bytes, uploadedByUserId: null,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("wrong_type");
    expect(await countRows("imported_files")).toBe(0);
  });

  it("refuses an empty file", async () => {
    const outcome = await uploadAndStage(testPool(), {
      filename: "empty.xlsx", bytes: Buffer.alloc(0), uploadedByUserId: null,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unparseable");
  });

  it("stages without writing a single business record", async () => {
    const outcome = await stage();
    expect(outcome.checksum).toBe(sha256(bytes));
    expect(outcome.checksum).toMatch(/^[0-9a-f]{64}$/);

    expect(await countRows("imported_files")).toBe(1);
    // Staging is not a commit: nothing official exists yet.
    expect(await countRows("payroll_transactions")).toBe(0);
    expect(await countRows("import_batches")).toBe(0);
    expect(await countRows("import_rows")).toBe(0);
    expect(await countRows("individuals")).toBe(0);
    expect(await countRows("employees")).toBe(0);
    expect(await countRows("service_sessions")).toBe(0);
  });

  it("classifies every source row and preserves the count", async () => {
    const { staging } = await stage();
    expect(staging.totalSourceRows).toBe(ALL_ROWS.length);
    const { valid, invalid, needsReview, duplicates } = staging.counts;
    expect(valid + invalid + needsReview + duplicates).toBe(ALL_ROWS.length);
    expect(valid).toBe(ALL_ROWS.length);
  });

  it("detects the three-person group and never divides its hours", async () => {
    const { staging } = await stage();
    expect(staging.counts.groupsDetected).toBe(1);
    expect(staging.counts.groupsNeedingReview).toBe(0);

    const group = staging.groups.find((g) => g.groupSize === 3);
    expect(group).toBeDefined();
    expect(group!.status).toBe("detected");
    expect(dec(group!.physicalHours).toNumber()).toBe(13);
    expect(dec(group!.combinedRate).toNumber()).toBe(57);
    expect(dec(group!.combinedAmount).toNumber()).toBe(741); // 13 x 57
    expect(group!.allocations).toHaveLength(3);
    for (const allocation of group!.allocations) {
      expect(dec(allocation.allocationHours).toNumber()).toBe(13); // NOT 13/3
      expect(dec(allocation.allocatedRate).toNumber()).toBe(19); // 57 / 3
      expect(dec(allocation.allocatedAmount).toNumber()).toBe(247); // 741 / 3
    }
  });

  it("flags the $23 Self-Hire Respite row against the configured $18", async () => {
    const { staging } = await stage();
    expect(staging.counts.rateExceptions).toBe(1);
    const warning = staging.warnings.find((w) => w.category === "rate_exception");
    expect(warning).toBeDefined();
    // The warning a reviewer reads names both rates in plain language.
    expect(warning!.message).toContain("$23.00");
    expect(warning!.message).toContain("$18.00");
    expect(warning!.severity).toBe("warning");
  });

  it("routes a suspicious combined group rate to one group review instead of per-row rate exceptions", async () => {
    const groupRows = ["Group Person One", "Group Person Two"].map((individual) => ({
      payTo: AGENCY_PAYEE,
      checkDate: "2025-04-20",
      checkNumber: "GROUP-112",
      code: "RG",
      hours: 13,
      rate: 112,
      amount: 728,
      totalNetPay: 728,
      periodBegin: "2025-04-01",
      periodEnd: "2025-04-15",
      program: "Day Hab",
      individual,
      employee: "Group Employee",
      internalAmount: 651.37,
    }));
    const groupBytes = await buildWorkbook(groupRows);
    const outcome = await uploadAndStage(testPool(), {
      filename: "group-rate-review.xlsx",
      bytes: groupBytes,
      uploadedByUserId: null,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.staging.counts.groupsNeedingReview).toBe(1);
    expect(outcome.staging.counts.rateExceptions).toBe(0);
    expect(outcome.staging.warnings.filter((warning) => warning.category === "rate_exception")).toHaveLength(0);
    expect(outcome.staging.warnings.filter((warning) => warning.category === "group_needs_review")).toHaveLength(1);
  });

  it("reconciles against the workbook's own control totals", async () => {
    const { staging } = await stage();
    expect(dec(staging.reconciliation.importedAgencyGross).toNumber()).toBe(EXPECTED_AGENCY_GROSS);
    expect(dec(staging.reconciliation.importedInternalAmount).toNumber()).toBe(
      EXPECTED_INTERNAL_AMOUNT,
    );
    expect(staging.reconciliation.agencyGrossMatches).toBe(true);
    expect(staging.reconciliation.internalAmountMatches).toBe(true);
    expect(staging.reconciliation.reconciled).toBe(true);
  });

  /* ---------------------------------------------------------------- commit */

  it("commits valid rows and writes every source row", async () => {
    const staged = await stage();
    const outcome = await commit(testPool(), staged.fileId, null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { counts } = outcome.result;
    expect(outcome.result.alreadyCommitted).toBe(false);
    expect(counts.sourceRows).toBe(ALL_ROWS.length);
    expect(counts.importRows).toBe(ALL_ROWS.length); // every source row preserved
    expect(counts.transactions).toBe(ALL_ROWS.length);
    expect(counts.individualsCreated).toBe(5);
    expect(counts.employeesCreated).toBe(3);
    expect(counts.rateExceptions).toBe(1);

    expect(await countRows("payroll_transactions")).toBe(ALL_ROWS.length);
    expect(await countRows("import_rows")).toBe(ALL_ROWS.length);
    expect(await countRows("rate_exceptions")).toBe(1);
    expect(await countRows("individuals")).toBe(5);
    expect(await countRows("employees")).toBe(3);
  }, 60_000);

  it("stores group hours once on the session and in full on each allocation", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);

    const { rows: sessions } = await testPool().query<{
      physical_hours: string; group_size: number; combined_amount: string;
    }>(
      `SELECT physical_hours::text, group_size, combined_amount::text
       FROM service_sessions WHERE group_detection_status = 'detected'`,
    );
    expect(sessions).toHaveLength(1);
    expect(dec(sessions[0].physical_hours).toNumber()).toBe(13);
    expect(sessions[0].group_size).toBe(3);
    expect(dec(sessions[0].combined_amount).toNumber()).toBe(741);

    const { rows: allocations } = await testPool().query<{
      allocation_hours: string; allocated_amount: string;
    }>(
      `SELECT a.allocation_hours::text, a.allocated_amount::text
       FROM service_allocations a
       JOIN service_sessions s ON s.id = a.service_session_id
       WHERE s.group_detection_status = 'detected'`,
    );
    expect(allocations).toHaveLength(3);
    const totalHours = allocations.reduce((sum, a) => sum + dec(a.allocation_hours).toNumber(), 0);
    const totalMoney = allocations.reduce((sum, a) => sum + dec(a.allocated_amount).toNumber(), 0);
    expect(totalHours).toBe(39); // 3 x 13: hours multiply across members
    expect(totalMoney).toBe(741); // money divides and conserves exactly
  }, 60_000);

  it("applies the agency conversion ratios, not a rebuilt hours x rate", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);

    const { rows } = await testPool().query<{
      program: string; imported_amount: string; calculated_internal_amount: string;
    }>(
      `SELECT p.code AS program, t.imported_amount::text, t.calculated_internal_amount::text
       FROM payroll_transactions t JOIN programs p ON p.id = t.program_id
       ORDER BY p.code, t.source_row_number`,
    );
    const byProgram = (code: string) => rows.filter((r) => r.program === code);

    const comHab = byProgram("COM_HAB")[0];
    expect(dec(comHab.calculated_internal_amount).toNumber()).toBe(210); // 250 x 21/25

    const respite = byProgram("RESPITE")[0];
    expect(dec(respite.calculated_internal_amount).toNumber()).toBe(85); // 95 x 17/19

    for (const dayHab of byProgram("DAY_HAB")) {
      // 247 x 17/19 = 221. Rebuilding as 13h x $17 would give 221 by luck here,
      // so the assertion that matters is the ratio holding on the whole group.
      expect(dec(dayHab.calculated_internal_amount).toNumber()).toBe(221);
    }

    const selfHire = byProgram("SH_RESPITE")[0];
    expect(dec(selfHire.calculated_internal_amount).toNumber()).toBe(92); // ratio 1.0

    const totalInternal = rows.reduce(
      (sum, r) => sum + dec(r.calculated_internal_amount).toNumber(), 0,
    );
    expect(totalInternal).toBe(EXPECTED_INTERNAL_AMOUNT);
  }, 60_000);

  it("preserves the imported rate exactly rather than replacing it", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);

    const { rows } = await testPool().query<{ imported_rate: string; expected_rate: string }>(
      `SELECT x.imported_rate::text, x.expected_rate::text FROM rate_exceptions x`,
    );
    expect(rows).toHaveLength(1);
    expect(dec(rows[0].imported_rate).toNumber()).toBe(23);
    expect(dec(rows[0].expected_rate).toNumber()).toBe(18);

    const { rows: tx } = await testPool().query<{ imported_rate: string }>(
      `SELECT t.imported_rate::text FROM payroll_transactions t
       JOIN programs p ON p.id = t.program_id WHERE p.code = 'SH_RESPITE'`,
    );
    expect(dec(tx[0].imported_rate).toNumber()).toBe(23);
  }, 60_000);

  it("keeps every transaction traceable to its source file and row", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);
    const { rows } = await testPool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM payroll_transactions
       WHERE source_file_id IS NULL OR source_row_number IS NULL OR import_row_id IS NULL`,
    );
    expect(Number(rows[0].c)).toBe(0);
  }, 60_000);

  it("writes an import batch with the reconciliation figures", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);
    const { rows } = await testPool().query<{
      status: string; total_rows: number; imported_rows: number;
      source_agency_gross: string | null; imported_agency_gross: string | null;
    }>(
      `SELECT status, total_rows, imported_rows,
              source_agency_gross::text, imported_agency_gross::text
       FROM import_batches`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("committed");
    expect(rows[0].total_rows).toBe(ALL_ROWS.length);
    expect(rows[0].imported_rows).toBe(ALL_ROWS.length);
    expect(dec(rows[0].source_agency_gross!).toNumber()).toBe(EXPECTED_AGENCY_GROSS);
    expect(dec(rows[0].imported_agency_gross!).toNumber()).toBe(EXPECTED_AGENCY_GROSS);
  }, 60_000);

  /* ------------------------------------------------- duplicate prevention */

  it("blocks re-uploading a workbook that has already been committed", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);

    const again = await uploadAndStage(testPool(), {
      filename: "a-different-name.xlsx", bytes, uploadedByUserId: null,
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("duplicate_file");
    expect(again.fileId).toBe(staged.fileId);
    expect(await countRows("imported_files")).toBe(1);
  }, 60_000);

  it("blocks a second upload of a workbook that is merely staged", async () => {
    await stage();
    const again = await uploadAndStage(testPool(), {
      filename: "copy.xlsx", bytes, uploadedByUserId: null,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("already_staged");
    expect(await countRows("imported_files")).toBe(1);
  });

  it("commits the same file twice without creating a single duplicate transaction", async () => {
    const staged = await stage();
    const first = await commit(testPool(), staged.fileId, null);
    expect(first.ok).toBe(true);

    const afterFirst = {
      transactions: await countRows("payroll_transactions"),
      sessions: await countRows("service_sessions"),
      allocations: await countRows("service_allocations"),
      batches: await countRows("import_batches"),
      rows: await countRows("import_rows"),
    };
    expect(afterFirst.transactions).toBe(ALL_ROWS.length);

    // A second commit of the same staged file must be a no-op.
    const second = await commit(testPool(), staged.fileId, null);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_committed");

    expect(await countRows("payroll_transactions")).toBe(afterFirst.transactions);
    expect(await countRows("service_sessions")).toBe(afterFirst.sessions);
    expect(await countRows("service_allocations")).toBe(afterFirst.allocations);
    expect(await countRows("import_batches")).toBe(afterFirst.batches);
    expect(await countRows("import_rows")).toBe(afterFirst.rows);
  }, 90_000);

  it("catches every row as a confirmed duplicate when the same data is staged again", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);

    // Same rows, different bytes: the file checksum no longer matches, so the
    // file-level guard cannot help and row-level fingerprints have to.
    const renamed = await buildWorkbook([...ALL_ROWS].reverse());
    const second = await uploadAndStage(testPool(), {
      filename: "same-data-different-order.xlsx", bytes: renamed, uploadedByUserId: null,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.staging.counts.duplicates).toBe(ALL_ROWS.length);
    expect(second.staging.counts.confirmedDuplicates).toBe(ALL_ROWS.length);
    expect(second.staging.counts.valid).toBe(0);
    expect(second.staging.counts.rateExceptions).toBe(0);

    // A whole-workbook re-import is not a reconciliation failure: nothing new
    // was imported, but the workbook is fully present in the ledger already.
    // The note must say so plainly rather than telling the operator to
    // "investigate" a correct outcome.
    expect(second.staging.reconciliation.note).not.toMatch(/investigate/i);
    expect(second.staging.reconciliation.note).toMatch(/fully accounted for/i);
    expect(second.staging.reconciliation.note).toContain(String(ALL_ROWS.length));

    const result = await commit(testPool(), second.fileId, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.counts.transactions).toBe(0);
    expect(result.result.counts.duplicateRows).toBe(ALL_ROWS.length);
    expect(result.result.counts.rateExceptions).toBe(0);
    // Every source row is still preserved, it just did not become a transaction.
    expect(result.result.counts.importRows).toBe(ALL_ROWS.length);

    expect(await countRows("payroll_transactions")).toBe(ALL_ROWS.length);
    expect(await countRows("import_rows")).toBe(ALL_ROWS.length * 2);
    expect(await countRows("rate_exceptions")).toBe(1);
  }, 120_000);

  it("produces the same fingerprint before and after the rows exist in the database", async () => {
    const first = await stage();
    const beforeCommit = first.staging.rows.map((r) => r.fingerprint);
    await commit(testPool(), first.fileId, null);

    const { rows } = await testPool().query<{ transaction_fingerprint: string }>(
      `SELECT transaction_fingerprint FROM payroll_transactions ORDER BY source_row_number`,
    );
    const afterCommit = rows.map((r) => r.transaction_fingerprint);
    expect(afterCommit.sort()).toEqual([...beforeCommit].filter(Boolean).sort());
  }, 60_000);

  /* --------------------------------------------------------------- discard */

  it("discards a staged upload and leaves nothing behind", async () => {
    const staged = await stage();
    expect((await discard(testPool(), staged.fileId)).ok).toBe(true);
    expect(await countRows("imported_files")).toBe(0);
    expect(await loadFile(testPool(), staged.fileId)).toBeNull();
  });

  it("refuses to discard something already committed", async () => {
    const staged = await stage();
    await commit(testPool(), staged.fileId, null);
    const outcome = await discard(testPool(), staged.fileId);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("already_committed");
    expect(await countRows("imported_files")).toBe(1);
  }, 60_000);
});

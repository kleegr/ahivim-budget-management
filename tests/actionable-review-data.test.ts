import { describe, expect, it } from "vitest";
import { listActionableImportWarnings, listCommittedDuplicateWarnings, listImports } from "@/lib/data/app-queries";
import { exceptionCounts } from "@/lib/data/queries";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import { listCorrectionQueue } from "@/lib/manage/import-corrections";
import { listOpenConflicts, listSyncRuns } from "@/lib/sheets/queries";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";

describe("actionable review read models", () => {
  it("can narrow a correction queue to one source row", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("count(*)")) return { rows: [{ c: "1" }] };
        return {
          rows: [{
            id: ROW_ID,
            source_row_number: 19,
            sheet_name: "Payroll",
            status: "needs_review",
            correction_status: null,
            raw_values: { Program: "Unknown" },
            corrected_values: null,
            validation_errors: null,
            resolved_individual_id: null,
            resolved_employee_id: null,
            resolved_program_id: null,
            individual_name: null,
            employee_name: null,
            program_name: null,
            correction_reason: null,
          }],
        };
      },
    };

    const result = await listCorrectionQueue(pool as never, BATCH_ID, { rowId: ROW_ID });

    expect(result.rows).toHaveLength(1);
    expect(calls[0]?.sql).toContain("r.id = $5");
    expect(calls[0]?.params).toEqual([BATCH_ID, null, null, false, ROW_ID]);
    expect(calls[1]?.params).toEqual([BATCH_ID, null, null, false, ROW_ID, 100, 0]);
  });

  it("keeps confirmed repeats out of the correction queue", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        return sql.includes("count(*)") ? { rows: [{ c: "0" }] } : { rows: [] };
      },
    };

    await listCorrectionQueue(pool as never, BATCH_ID, { needingAttention: true });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("r.status IN ('needs_review','invalid')");
    expect(calls[0]).not.toContain("'duplicate'");
  });

  it("returns only warning rows with the file and row context needed for a fix link", async () => {
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        expect(params[0]).toEqual(["unknown_program"]);
        if (sql.includes("count(*)")) return { rows: [{ c: "1" }] };
        return {
          rows: [{
            id: "warning-1",
            import_row_id: ROW_ID,
            individual_id: null,
            import_batch_id: BATCH_ID,
            category: "unknown_program",
            severity: "warning",
            message: "Unknown program value",
            details: null,
            source_row_number: 19,
            row_status: "needs_review",
            resolved_at: null,
            file_id: "file-1",
            filename: "payroll.xlsx",
            individual_name: null,
          }],
        };
      },
    };

    const result = await listActionableImportWarnings(pool as never, {
      categories: ["unknown_program"],
    });

    expect(result).toMatchObject({
      total: 1,
      rows: [{ fileId: "file-1", importRowId: ROW_ID, rowStatus: "needs_review" }],
    });
    // Confirmed repeats are already represented by an earlier ledger row and
    // therefore belong in source history, not in a correction queue.
    const sqlCalls: string[] = [];
    const emptyPool = {
      query: async (sql: string) => {
        sqlCalls.push(sql);
        return { rows: sql.includes("count(*)") ? [{ c: "0" }] : [] };
      },
    };
    await listActionableImportWarnings(emptyPool as never);
    expect(sqlCalls[0]).toContain("r.status IN ('needs_review','invalid')");
    expect(sqlCalls[0]).not.toContain("'duplicate'");
  });

  it("keeps committed duplicate candidates in exact ledger inspection", async () => {
    const transactionId = "33333333-3333-4333-8333-333333333333";
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("count(*)")) return { rows: [{ c: "1" }] };
        return {
          rows: [{
            id: "warning-duplicate",
            import_row_id: ROW_ID,
            transaction_id: transactionId,
            import_batch_id: BATCH_ID,
            file_id: "file-1",
            filename: "payroll.xlsx",
            source_row_number: 20,
            individual_id: null,
            individual_name: "Ari Cohen",
            employee_name: "Sam Lee",
            check_number: "CHECK-1",
            period_begin: "2026-08-01",
            period_end: "2026-08-15",
            message: "Same natural key as an earlier row.",
          }],
        };
      },
    };

    const result = await listCommittedDuplicateWarnings(pool as never);

    expect(result).toMatchObject({ total: 1, rows: [{ transactionId, importRowId: ROW_ID }] });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("r.status = 'imported'");
    expect(calls[1]!.sql).toContain("LEFT JOIN LATERAL");
    expect(calls[1]!.sql).toContain("candidate.import_row_id = r.id");
    expect(calls[1]!.sql).toContain("LIMIT 1");
  });

  it("projects source context for sync conflicts and run history", async () => {
    let conflictSql = "";
    const conflictPool = {
      query: async (sql: string) => {
        conflictSql = sql;
        return ({
        rows: [{
          id: "conflict-1",
          type: "changed",
          status: "open",
          audited: true,
          natural_key: "source-key",
          detail: "Amount changed",
          previous: { amount: "20" },
          incoming: { amount: "25" },
          payroll_transaction_id: "transaction-1",
          import_row_id: ROW_ID,
          source_file_id: "file-1",
          individual_name: "Ari Cohen",
          employee_name: "Sam Lee",
          program_name: "Respite",
          created_at: "2026-08-30T12:00:00Z",
        }],
        });
      },
    };
    const [conflict] = await listOpenConflicts(conflictPool as never);
    expect(conflict).toMatchObject({
      transactionId: "transaction-1",
      importRowId: ROW_ID,
      sourceFileId: "file-1",
    });
    expect(conflictSql).toContain("held_row.status IN ('needs_review', 'invalid', 'duplicate')");

    const runPool = {
      query: async () => ({
        rows: [{
          id: "run-1",
          trigger: "manual",
          status: "failed",
          source_rows: 10,
          rows_added: 0,
          rows_updated: 0,
          rows_skipped: 9,
          rows_flagged: 1,
          rows_failed: 1,
          import_batch_id: BATCH_ID,
          source_file_id: "file-1",
          error_message: "One row needs review.",
          started_at: "2026-08-30T12:00:00Z",
          finished_at: "2026-08-30T12:01:00Z",
          triggered_by: "Admin",
          reconciliation: null,
        }],
      }),
    };
    const [run] = await listSyncRuns(runPool as never, 1);
    expect(run.sourceFileId).toBe("file-1");
  });

  it("filters reconciliation issues before ordering and limiting imports", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };

    await listImports(pool as never, 100, { reconciliationNeedsReview: true });

    expect(calls).toHaveLength(1);
    const sql = calls[0]!.sql;
    expect(sql.indexOf("WHERE b.reconciliation_notes")).toBeGreaterThan(-1);
    expect(sql.indexOf("WHERE b.reconciliation_notes")).toBeLessThan(sql.indexOf("ORDER BY f.uploaded_at"));
    expect(sql.indexOf("ORDER BY f.uploaded_at")).toBeLessThan(sql.indexOf("LIMIT $1"));
    expect(calls[0]!.params).toEqual([100]);
  });

  it("distinguishes imports whose control totals were never checked", async () => {
    const pool = {
      query: async () => ({
        rows: [{
          file_id: "file-1",
          batch_id: "batch-1",
          filename: "without-control-totals.xlsx",
          byte_size: 1024,
          checksum: "abc",
          uploaded_at: "2026-08-30T12:00:00Z",
          uploaded_by: "Admin",
          status: "committed",
          total_rows: 1,
          valid_rows: 1,
          imported_rows: 1,
          actionable_rows: 0,
          warning_rows: 0,
          error_rows: 0,
          duplicate_rows: 0,
          committed_at: "2026-08-30T12:01:00Z",
          reconciliation_checked: false,
          reconciliation_needs_review: false,
        }],
      }),
    };

    const [row] = await listImports(pool as never, 1);

    expect(row.reconciliationChecked).toBe(false);
    expect(row.reconciliationNeedsReview).toBe(false);
  });

  it("reports the same held-row count that the correction queue can open", async () => {
    let sql = "";
    const pool = {
      query: async (statement: string) => {
        sql = statement;
        return { rows: [{
          file_id: "file-1",
          batch_id: BATCH_ID,
          filename: "review.xlsx",
          byte_size: 1024,
          checksum: "abc",
          uploaded_at: "2026-08-30T12:00:00Z",
          uploaded_by: "Admin",
          status: "committed",
          total_rows: 10,
          valid_rows: 8,
          imported_rows: 8,
          actionable_rows: 2,
          warning_rows: 7,
          error_rows: 1,
          duplicate_rows: 1,
          committed_at: "2026-08-30T12:01:00Z",
          reconciliation_checked: true,
          reconciliation_needs_review: false,
        }] };
      },
    };

    const [row] = await listImports(pool as never, 1);

    expect(row.actionableRows).toBe(2);
    expect(row.warningRows).toBe(7);
    expect(sql).toContain("held.status IN ('needs_review', 'invalid')");
    expect(sql).not.toContain("held.status IN ('needs_review', 'invalid', 'duplicate')");
  });

  it("keeps overview exception counts aligned with fixable held rows", async () => {
    let sql = "";
    const pool = {
      query: async (statement: string) => {
        sql = statement;
        return { rows: [{}] };
      },
    };

    await exceptionCounts(pool as never, { includeOverAuthorization: false });

    expect(sql.match(/r\.status IN \('needs_review','invalid'\)/g)).toHaveLength(2);
    expect(sql).not.toContain("r.status IN ('needs_review','invalid','duplicate')");
  });

  it("loads an exact transaction in SQL instead of scanning the ledger", async () => {
    const transactionId = "33333333-3333-4333-8333-333333333333";
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };

    await listTransactionsForGrid(pool as never, undefined, { transactionId });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("AND t.id = ANY($1::uuid[])");
    expect(calls[0]?.params).toEqual([[transactionId]]);

    const invalid = await listTransactionsForGrid(pool as never, undefined, { transactionId: "not-a-uuid" });
    expect(invalid).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("accepts a large selection only after a server-side scoped source resolved it", async () => {
    const transactionIds = Array.from({ length: 201 }, (_, index) => (
      `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`
    ));
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };

    await expect(listTransactionsForGrid(pool as never, undefined, { transactionIds })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);

    await listTransactionsForGrid(pool as never, undefined, {
      transactionIds,
      allowLargeTransactionSelection: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([transactionIds]);
  });
});

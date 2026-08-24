import { describe, expect, it, vi } from "vitest";
import { commitStagedImport, type CommitInput, type PgLikePool } from "@/lib/import/commit";
import { updateStrategy } from "@/lib/manage/calculation-strategies";
import { saveEmployeeDeal } from "@/lib/manage/employee-deals";
import { mergeEmployees } from "@/lib/manage/employee-merge";
import { mergeIndividuals } from "@/lib/manage/individual-merge";
import { SETTLEMENT_SOURCE_LOCK } from "@/lib/manage/settlement-freshness";

interface QueryCall {
  sql: string;
  params?: unknown[];
}

type QueryResult = { rows: unknown[]; rowCount?: number | null };

function recordingPool(
  respond: (sql: string, params?: unknown[]) => QueryResult = () => ({ rows: [] }),
): { pool: PgLikePool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return respond(sql, params);
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => client),
  } as unknown as PgLikePool;
  return { pool, calls };
}

function expectSourceLockImmediatelyAfterBegin(calls: QueryCall[]): void {
  expect(calls[0]?.sql).toBe("BEGIN");
  expect(calls[1]?.sql).toContain("pg_advisory_xact_lock");
  expect(calls[1]?.params).toEqual([SETTLEMENT_SOURCE_LOCK]);
}

function expectRowLockAfterSourceLock(calls: QueryCall[], table: string): void {
  expectSourceLockImmediatelyAfterBegin(calls);
  const rowLock = calls.findIndex(
    ({ sql }) => sql.includes(`FROM ${table}`) && sql.includes("FOR UPDATE"),
  );
  expect(rowLock).toBeGreaterThan(1);
}

const KEEP_ID = "00000000-0000-4000-8000-000000000001";
const MERGE_ID = "00000000-0000-4000-8000-000000000002";

describe("settlement source lock ordering", () => {
  it("locks before saveEmployeeDeal reads and locks the employee", async () => {
    const { pool, calls } = recordingPool();

    const result = await saveEmployeeDeal(pool, {
      employeeId: KEEP_ID,
      directRule: "keep_all",
      effectiveFrom: "2026-01-01",
      reason: "Regression test",
    }, null);

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expectRowLockAfterSourceLock(calls, "employees");
  });

  it("locks before updateStrategy reads and locks the strategy", async () => {
    const { pool, calls } = recordingPool(() => ({ rows: [], rowCount: 0 }));

    const result = await updateStrategy(pool, { id: KEEP_ID, label: "Updated" }, null);

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expectRowLockAfterSourceLock(calls, "calculation_strategies");
  });

  it("locks before mergeEmployees reads and locks either employee", async () => {
    const { pool, calls } = recordingPool();

    const result = await mergeEmployees(pool, { keepId: KEEP_ID, mergeId: MERGE_ID }, null);

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expectRowLockAfterSourceLock(calls, "employees");
  });

  it("locks before mergeIndividuals reads and locks either individual", async () => {
    const { pool, calls } = recordingPool();

    const result = await mergeIndividuals(pool, { keepId: KEEP_ID, mergeId: MERGE_ID }, null);

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expectRowLockAfterSourceLock(calls, "individuals");
  });

  it("locks before commitStagedImport takes its file lock or reads import state", async () => {
    const checksum = "a".repeat(64);
    const { pool, calls } = recordingPool((sql) => {
      if (sql.includes("FROM import_batches")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000003",
            imported_file_id: "00000000-0000-4000-8000-000000000004",
          }],
        };
      }
      return { rows: [] };
    });
    const input: CommitInput = {
      checksumSha256: checksum,
      originalFilename: "existing.xlsx",
      byteSize: 0,
      templateDetected: "test",
      sheetSummary: {},
      parsedRows: [],
      staging: {
        totalSourceRows: 0,
        rows: [],
        warnings: [],
        groups: [],
        counts: {
          valid: 0,
          invalid: 0,
          needsReview: 0,
          duplicates: 0,
          confirmedDuplicates: 0,
          possibleDuplicates: 0,
          warningRows: 0,
          unknownPrograms: 0,
          unmatchedIndividuals: 0,
          unmatchedEmployees: 0,
          ambiguousNames: 0,
          rateExceptions: 0,
          groupsDetected: 0,
          groupsNeedingReview: 0,
        },
        reconciliation: {
          importedAgencyGross: "0.0000",
          importedInternalAmount: "0.0000",
          workbookAgencyGross: null,
          workbookInternalAmount: null,
          agencyGrossMatches: null,
          internalAmountMatches: null,
          reconciled: false,
          note: "No totals to compare.",
        },
        unknownProgramLabels: [],
        unmatchedIndividualNames: [],
        unmatchedEmployeeNames: [],
      },
      ratesByProgram: {},
      committedByUserId: null,
    };

    const result = await commitStagedImport(pool, input);

    expect(result.alreadyCommitted).toBe(true);
    expectSourceLockImmediatelyAfterBegin(calls);
    expect(calls[2]?.sql).toContain("pg_advisory_xact_lock");
    expect(calls[2]?.params).toEqual([checksum]);
    expect(calls.findIndex(({ sql }) => sql.includes("FROM import_batches"))).toBeGreaterThan(2);
  });
});

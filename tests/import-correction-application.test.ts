import { describe, expect, it } from "vitest";
import { canonicalServiceDate } from "@/lib/business/service-date";
import { correctRowFields, parseCorrectedImportSource } from "@/lib/manage/import-corrections";

const ROW_ID = "22222222-2222-4222-8222-222222222222";

function source(overrides: Record<string, string> = {}) {
  return {
    raw: {
      payTo: "Excellent Staffing",
      checkDate: "8/15/2025",
      checkNumber: "100",
      code: "RG",
      hours: "2",
      rate: "19",
      amount: "38",
      totalNetPay: "30",
      periodBegin: "8/1/2025",
      periodEnd: "8/15/2025",
      programDescription: "Unknown Day Program",
      individual: "Aaron Levy",
      employee: "Miriam Klein",
      nonContractHeader: "",
      calculatedInternalAmount: "34",
      dedupNetPayFormula: "",
      paid: "",
      ...overrides,
    },
    formulas: { calculatedInternalAmount: "source formula" },
  };
}

describe("corrected import source validation", () => {
  it("layers a sparse correction over preserved source cells and normalizes dates", () => {
    const raw = source();
    const result = parseCorrectedImportSource(raw, { amount: "40", hours: "2.5" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.amount).toBe("40");
    expect(result.row.hours).toBe("2.5");
    expect(result.row.periodBegin).toBe("2025-08-01");
    expect((raw.raw as Record<string, string>).amount).toBe("38");
  });

  it("refuses a non-service or invalid corrected row", () => {
    const zeroHours = parseCorrectedImportSource(source(), { hours: "0" });
    expect(zeroHours).toEqual({
      ok: false,
      message: "hours: a single-person service row must be greater than zero.",
    });
    const missingProgram = parseCorrectedImportSource(source({ programDescription: "" }), null);
    expect(missingProgram.ok).toBe(false);
    if (!missingProgram.ok) expect(missingProgram.message).toContain("Program description is required");
  });
});

describe("canonical service date", () => {
  it("uses period begin, then check date, then period end without inventing a date", () => {
    expect(canonicalServiceDate({
      periodBegin: "2025-08-01",
      checkDate: "2025-08-15",
      periodEnd: "2025-08-31",
    })).toBe("2025-08-01");
    expect(canonicalServiceDate({
      periodBegin: null,
      checkDate: "2025-08-15",
      periodEnd: "2025-08-31",
    })).toBe("2025-08-15");
    expect(canonicalServiceDate({
      periodBegin: null,
      checkDate: null,
      periodEnd: "2025-08-31",
    })).toBe("2025-08-31");
    expect(canonicalServiceDate({
      periodBegin: null,
      checkDate: null,
      periodEnd: null,
    })).toBeNull();
  });
});

describe("correction write integrity", () => {
  function poolThatRecords(options: { failAudit?: boolean } = {}) {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM import_rows r WHERE r.id")) {
          return {
            rows: [{
              id: ROW_ID,
              status: "needs_review",
              corrected_values: { hours: "2" },
              resolved_individual_id: null,
              resolved_employee_id: null,
              resolved_program_id: null,
              transaction_id: null,
            }],
          };
        }
        if (sql.includes("UPDATE import_rows")) {
          return { rowCount: 1, rows: [{ corrected_values: { hours: "2", rate: "21" } }] };
        }
        if (options.failAudit && sql.includes("INSERT INTO audit_logs")) {
          throw new Error("audit unavailable");
        }
        return { rowCount: 1, rows: [] };
      },
      release: () => undefined,
    };
    return {
      statements,
      pool: { query: client.query, connect: async () => client },
    };
  }

  it("locks the row and merges a sparse field patch inside the audit transaction", async () => {
    const { pool, statements } = poolThatRecords();

    const result = await correctRowFields(pool as never, ROW_ID, { rate: "21" }, null);

    expect(result.ok).toBe(true);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements.find((sql) => sql.includes("UPDATE import_rows"))).toContain(
      "COALESCE(corrected_values, '{}'::jsonb) || $2::jsonb",
    );
    expect(statements).toContainEqual(expect.stringContaining("INSERT INTO audit_logs"));
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("rolls back the field patch when its audit entry cannot be written", async () => {
    const { pool, statements } = poolThatRecords({ failAudit: true });

    await expect(correctRowFields(pool as never, ROW_ID, { rate: "21" }, null))
      .rejects.toThrow("audit unavailable");

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
});

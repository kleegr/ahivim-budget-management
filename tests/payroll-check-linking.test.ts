import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { savePayrollCheck } from "@/lib/manage/direct-pay-operations";

describe("payroll-check transaction linking", () => {
  it("requires a check number plus every supplied discriminator before period fallbacks", async () => {
    const checkId = "123e4567-e89b-12d3-a456-426614174010";
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO employee_payroll_checks")) return { rows: [{ id: checkId }] };
        if (sql.includes("SELECT count(*)::text AS count")) return { rows: [{ count: "1" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PgLikePool;

    const result = await savePayrollCheck(pool, {
      employeeId,
      checkNumber: " CHECK-10 ",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      actualGross: "500",
      actualNet: "420",
    }, null);

    expect(result).toMatchObject({ ok: true, data: { id: checkId, linkedTransactions: 1 } });
    const insert = calls.find(({ sql }) => sql.includes("INSERT INTO employee_payroll_checks"));
    expect(insert?.params?.slice(5, 8)).toEqual(["500.0000", "420.0000", "80.0000"]);
    const link = calls.find(({ sql }) => sql.includes("SET payroll_check_id = $1"));
    expect(link?.params).toEqual([
      checkId,
      employeeId,
      "CHECK-10",
      "2026-08-15",
      "2026-08-01",
      "2026-08-14",
    ]);
    expect(link?.sql).toContain("$3::text IS NOT NULL");
    expect(link?.sql).toContain("NULLIF(btrim(t.check_number), '') = $3");
    expect(link?.sql).toContain("($4::date IS NULL OR t.check_date = $4::date)");
    expect(link?.sql).toContain("($5::date IS NULL OR t.period_begin = $5::date)");
    expect(link?.sql).toContain("($6::date IS NULL OR t.period_end = $6::date)");
    expect(link?.sql).toContain("$3::text IS NULL AND $5::date IS NOT NULL");
    expect(link?.sql).toContain("$5::date IS NULL AND $6::date IS NULL AND $3::text IS NULL");
  });

  it("rejects a separately supplied withholding that conflicts with gross minus net", async () => {
    const pool = { connect: vi.fn() } as unknown as PgLikePool;

    const result = await savePayrollCheck(pool, {
      employeeId: "123e4567-e89b-12d3-a456-426614174000",
      checkDate: "2026-08-15",
      actualGross: "500",
      actualNet: "420",
      taxWithheld: "79",
    }, null);

    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      message: "Withholding is calculated as actual gross minus actual net and cannot be entered separately.",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("keeps a net-only check unverified and requires gross before verification", async () => {
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const pool = { connect: vi.fn() } as unknown as PgLikePool;

    const verified = await savePayrollCheck(pool, {
      employeeId,
      checkDate: "2026-08-15",
      actualNet: "420",
      verificationStatus: "verified",
    }, null);

    expect(verified).toMatchObject({
      ok: false,
      code: "validation",
      message: "Add the verified check gross before marking this payroll check verified.",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects blank or omitted net amounts before a verified check can be saved", async () => {
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const pool = { connect: vi.fn() } as unknown as PgLikePool;
    const check = {
      employeeId,
      checkDate: "2026-08-15",
      actualGross: "500",
      verificationStatus: "verified" as const,
    };

    const blank = await savePayrollCheck(pool, { ...check, actualNet: "" }, null);
    const omitted = await savePayrollCheck(
      pool,
      check as unknown as Parameters<typeof savePayrollCheck>[1],
      null,
    );

    for (const result of [blank, omitted]) {
      expect(result).toMatchObject({
        ok: false,
        code: "validation",
        message: "Enter the payroll check net amount.",
      });
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("links a missing-identity source by its exact locked transaction id", async () => {
    const checkId = "123e4567-e89b-12d3-a456-426614174010";
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const sourceId = "123e4567-e89b-12d3-a456-426614174020";
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("FROM payroll_transactions t") && sql.includes("FOR UPDATE OF t")) {
          return { rows: [{ id: sourceId, employee_id: employeeId, payroll_check_id: null, payment_recipient: "employee" }] };
        }
        if (sql.includes("INSERT INTO employee_payroll_checks")) return { rows: [{ id: checkId }] };
        if (sql.includes("SELECT count(*)::text AS count")) return { rows: [{ count: "1" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PgLikePool;

    const result = await savePayrollCheck(pool, {
      employeeId,
      checkDate: "2026-08-15",
      actualNet: "420",
      sourceTransactionIds: [sourceId],
    }, null);

    expect(result).toMatchObject({ ok: true, data: { id: checkId, linkedTransactions: 1 } });
    const lock = calls.find(({ sql }) => sql.includes("FOR UPDATE OF t"));
    expect(lock?.params).toEqual([[sourceId]]);
    const exactLink = calls.find(({ sql }) => sql.includes("WHERE id = ANY($2::uuid[])"));
    expect(exactLink?.params).toEqual([checkId, [sourceId], employeeId]);
    expect(exactLink?.sql).toContain("payroll_check_id IS NULL");
    expect(calls.some(({ sql }) => sql.includes("NULLIF(btrim(t.check_number), '') = $3"))).toBe(false);
  });

  it("does not let a tampered or missing source id create an orphan check", async () => {
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const sourceId = "123e4567-e89b-12d3-a456-426614174020";
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("FOR UPDATE OF t")) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await savePayrollCheck(pool, {
      employeeId,
      checkDate: "2026-08-15",
      actualNet: "420",
      sourceTransactionIds: [sourceId],
    }, null);

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(calls.some((sql) => sql.includes("INSERT INTO employee_payroll_checks"))).toBe(false);
  });

  it("rejects an exact source row owned by another employee", async () => {
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const otherEmployeeId = "123e4567-e89b-12d3-a456-426614174001";
    const sourceId = "123e4567-e89b-12d3-a456-426614174020";
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("FOR UPDATE OF t")) {
          return { rows: [{ id: sourceId, employee_id: otherEmployeeId, payroll_check_id: null, payment_recipient: "employee" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await savePayrollCheck(pool, {
      employeeId,
      checkDate: "2026-08-15",
      actualNet: "420",
      sourceTransactionIds: [sourceId],
    }, null);

    expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls.some((sql) => sql.includes("INSERT INTO employee_payroll_checks"))).toBe(false);
  });

  it("rejects an exact source row that was already linked concurrently", async () => {
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const sourceId = "123e4567-e89b-12d3-a456-426614174020";
    const existingCheckId = "123e4567-e89b-12d3-a456-426614174099";
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FOR UPDATE OF t")) {
          return { rows: [{ id: sourceId, employee_id: employeeId, payroll_check_id: existingCheckId, payment_recipient: "employee" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await savePayrollCheck(pool, {
      employeeId,
      checkDate: "2026-08-15",
      actualNet: "420",
      sourceTransactionIds: [sourceId],
    }, null);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
  });

  it("rejects an agency-paid source row before creating an employee payroll check", async () => {
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const sourceId = "123e4567-e89b-12d3-a456-426614174020";
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("FOR UPDATE OF t")) {
          return { rows: [{ id: sourceId, employee_id: employeeId, payroll_check_id: null, payment_recipient: "excellent_staffing" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await savePayrollCheck(pool, {
      employeeId,
      checkDate: "2026-08-15",
      actualNet: "420",
      sourceTransactionIds: [sourceId],
    }, null);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(calls.some((sql) => sql.includes("INSERT INTO employee_payroll_checks"))).toBe(false);
  });
});

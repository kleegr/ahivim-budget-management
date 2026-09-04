import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import { getSettlementDashboard } from "@/lib/data/settlements";
import { resolveSettlementSourceTransactions } from "@/lib/data/settlement-source-transactions";
import type { PgLikePool } from "@/lib/import/commit";
import { savePayrollCheck } from "@/lib/manage/direct-pay-operations";
import { createEmployee } from "@/lib/manage/employees";
import { createIndividual } from "@/lib/manage/individuals";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

function employeeScope(employeeId: string): AccessScope {
  return {
    ...fullAccess(ACTOR, "viewer"),
    full: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [],
    employeeIds: [employeeId],
    grantedIndividualIds: [],
    grantedEmployeeIds: [employeeId],
  };
}

suite("Money operations compact transaction sources (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'admin@example.test', 'Admin', 'x', 'admin')`,
      [ACTOR],
    );
  });

  afterAll(closeTestPool);

  it("round-trips ordinary, ambiguous, and verified-check sources without widening access", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Scoped Source Employee" }, ACTOR));
    const hiddenEmployee = unwrap(await createEmployee(pool, { displayName: "Hidden Source Employee" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Source Individual" }, ACTOR));

    const inserted = await pool.query<{ id: string; transaction_fingerprint: string }>(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, period_begin, period_end,
          payment_recipient, imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1,$3,'ORD-100','2026-08-15','2026-08-01','2026-08-14','employee','250',NULL,'compact-ordinary-1'),
         ($1,$3,'ORD-100','2026-08-15','2026-08-01','2026-08-14','employee','350',NULL,'compact-ordinary-2'),
         ($1,$3,'AMB-200','2026-08-20',NULL,NULL,'employee','300','900','compact-ambiguous-1'),
         ($1,$3,'AMB-200','2026-08-21',NULL,NULL,'employee','300','900','compact-ambiguous-2'),
         ($1,$3,'AMB-200',NULL,NULL,NULL,'employee','300','900','compact-ambiguous-3'),
         ($1,$3,'VER-300','2026-08-31','2026-08-16','2026-08-31','employee','400','800','compact-verified-1'),
         ($1,$3,'VER-300','2026-08-31','2026-08-16','2026-08-31','employee','400','800','compact-verified-2'),
         ($2,$3,'HIDDEN-400','2026-08-31','2026-08-16','2026-08-31','employee','500',NULL,'compact-hidden-1')
       RETURNING id, transaction_fingerprint`,
      [employee.id, hiddenEmployee.id, individual.id],
    );
    const ids = (prefix: string) => inserted.rows
      .filter((row) => row.transaction_fingerprint.startsWith(prefix))
      .map((row) => row.id)
      .sort();
    const verifiedIds = ids("compact-verified-");
    const verifiedCheck = unwrap(await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkNumber: "VER-300",
      checkDate: "2026-08-31",
      periodBegin: "2026-08-16",
      periodEnd: "2026-08-31",
      actualNet: "800",
      verificationStatus: "verified",
      sourceTransactionIds: verifiedIds,
    }, ACTOR));
    expect(verifiedCheck.linkedTransactions).toBe(2);

    const scope = employeeScope(employee.id);
    const dashboard = await getSettlementDashboard(pool, scope);
    const ordinary = dashboard.checkIssues.find((issue) =>
      issue.sourceId === `${employee.id}:check:ORD-100:date:2026-08-15:period:2026-08-01:2026-08-14`
    );
    const ambiguous = dashboard.checkIssues.find((issue) =>
      issue.sourceId === `${employee.id}:ambiguous-check:AMB-200`
    );
    expect(ordinary?.transactionIds).toEqual(ids("compact-ordinary-"));
    expect(ambiguous?.transactionIds).toEqual(ids("compact-ambiguous-"));
    expect(dashboard.checkIssues.every((issue) => issue.employeeId === employee.id)).toBe(true);

    await expect(resolveSettlementSourceTransactions(pool, scope, ordinary!.sourceId)).resolves.toEqual({
      transactionIds: ordinary!.transactionIds,
      tooLarge: false,
    });
    await expect(resolveSettlementSourceTransactions(pool, scope, ambiguous!.sourceId)).resolves.toEqual({
      transactionIds: ambiguous!.transactionIds,
      tooLarge: false,
    });
    await expect(resolveSettlementSourceTransactions(
      pool,
      scope,
      `${employee.id}:payroll-check:${verifiedCheck.id}`,
    )).resolves.toEqual({
      transactionIds: verifiedIds,
      tooLarge: false,
    });

    await expect(resolveSettlementSourceTransactions(
      pool,
      scope,
      `${hiddenEmployee.id}:check:HIDDEN-400:date:2026-08-31:period:2026-08-16:2026-08-31`,
    )).resolves.toEqual({ transactionIds: [], tooLarge: false });
  });
});

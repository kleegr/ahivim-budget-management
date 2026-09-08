import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";
import { recoverSourceBase, type SourceBaseRecoveryInput } from "@/lib/sheets/base-recovery";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;
const tables = [
  "payroll_transactions", "import_rows", "sheet_sync_rows", "sheet_sync_conflicts", "sheet_sync_runs",
  "import_warnings", "rate_exceptions", "employee_payroll_checks", "settlement_obligations",
  "settlement_obligation_transactions", "settlement_events", "settlement_batches", "settlement_ledger_state",
  "service_allocations", "service_sessions", "budget_authorizations", "budget_periods", "program_budget_events",
  "class_invoices", "class_invoice_lines", "class_budget_ledger", "audit_logs",
] as const;

type Transaction = { id: string; employee_id: string; individual_id: string; check_number: string | null };
type Context = Awaited<ReturnType<typeof setup>>;

async function setup(edit?: (values: string[][]) => void) {
  const pool = testPool(), fixture = await numericSheetFixture();
  const values = fixture.values.map(row => [...row]);
  for (const [index, row] of values.slice(3).entries()) {
    row[0] = "Excellent Staffing"; row[2] = `BASE-GUARD-${index}`;
    row[4] = "4"; row[5] = "25"; row[6] = index === 1 ? "200" : "100";
    row[7] = ""; row[10] = "Com Hab"; row[15] = index === 1 ? "168" : "84";
  }
  edit?.(values);
  const csv = sheetValuesToCsv(values), sourceHash = parseSheetCsv(csv).snapshotSha256;
  expect(await runSheetSync(pool, {
    trigger: "manual", userId: null, config: DEFAULT_SYNC_CONFIG, fetcher: async () => csv,
  })).toMatchObject({ status: "success", added: values.length - 3 });
  // Synthetic reproduction of the old retain-gross calculation; imported P,
  // the applied rates, source fingerprints and all original raw rows are intact.
  await pool.query(`UPDATE payroll_transactions SET calculated_internal_amount=imported_amount,
    employee_payment_amount=imported_amount,agency_additional_amount=0,internal_amount_mismatch=true`);
  await pool.query(`INSERT INTO import_warnings(import_batch_id,import_row_id,category,severity,message,details)
    SELECT i.import_batch_id,i.id,'internal_amount_mismatch','warning','Original calculation disagreement',
      jsonb_build_object('application',t.imported_amount::text,'spreadsheet',t.spreadsheet_internal_amount::text,
        'difference',(t.imported_amount-t.spreadsheet_internal_amount)::text)
    FROM payroll_transactions t JOIN import_rows i ON i.id=t.import_row_id`);
  const rows = (await pool.query<Transaction>(`SELECT id,employee_id,individual_id,check_number
    FROM payroll_transactions ORDER BY imported_amount`)).rows;
  const target = rows[0]!, sibling = rows[1]!;
  const action = (input: Partial<SourceBaseRecoveryInput> = {}, db: PgLikePool = pool) => recoverSourceBase(db, {
    action: "accept", reason: "Original source and recorded applied rates prove this legacy calculation error",
    operationKey: randomUUID(), sourceHash, transactionIds: [target.id], ...input,
  }, null, { fetcher: async () => csv });
  return { pool, rows, target, sibling, action };
}

async function controls() {
  const result = await testPool().query<{ table_name: string; count: string; full_hash: string }>(
    tables.map(table => `SELECT '${table}'::text AS table_name,count(*)::text AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) AS full_hash FROM "${table}" t`).join(" UNION ALL "),
  );
  return Object.fromEntries(result.rows.map(row => [row.table_name, { count: row.count, full_hash: row.full_hash }]));
}

async function obligation(ctx: Context, metadata: Record<string, unknown> = {}, employeeId = ctx.target.employee_id) {
  return (await ctx.pool.query<{ id: string }>(`INSERT INTO settlement_obligations
    (source_key,kind,direction,employee_id,original_amount,calculation_metadata)
    VALUES ($1,'employee_agency','payable',$2,100,$3) RETURNING id`,
  [randomUUID(), employeeId, JSON.stringify(metadata)])).rows[0]!.id;
}

async function payment(ctx: Context, obligationId: string, employeeId = ctx.target.employee_id) {
  return (await ctx.pool.query<{ id: string }>(`INSERT INTO settlement_events
    (settlement_obligation_id,employee_id,event_type,amount,occurred_on)
    VALUES ($1,$2,'payment',1,'2026-08-25') RETURNING id`, [obligationId, employeeId])).rows[0]!.id;
}

async function differentEmployee(ctx: Context) {
  return (await ctx.pool.query<{ id: string }>(`INSERT INTO employees(normalized_name,display_name)
    VALUES ('synthetic unrelated guard employee','Synthetic Unrelated Guard Employee') RETURNING id`)).rows[0]!.id;
}

const guards: Array<{
  name: string;
  message: RegExp;
  edit?: (values: string[][]) => void;
  arrange: (ctx: Context) => Promise<void>;
}> = [
  {
    name: "Paid compatible sibling with a missing pay-period boundary",
    message: /Paid/,
    edit: values => { values[4]![2] = values[3]![2]!; values[4]![8] = ""; },
    arrange: async ctx => { await ctx.pool.query("UPDATE payroll_transactions SET is_paid=true,paid_at=now() WHERE id=$1", [ctx.sibling.id]); },
  },
  {
    name: "Paid timestamp even when the boolean marker is false",
    message: /Paid/,
    arrange: async ctx => { await ctx.pool.query("UPDATE payroll_transactions SET is_paid=false,paid_at=now() WHERE id=$1", [ctx.target.id]); },
  },
  {
    name: "detached verified check with partial period metadata",
    message: /verified or void/,
    arrange: async ctx => {
      const inserted = await ctx.pool.query<{ verification_status: string }>(`INSERT INTO employee_payroll_checks
        (employee_id,check_number,check_date,period_begin,actual_gross,actual_net,verification_status)
        VALUES ($1,$2,'2026-08-21',NULL,100,80,'verified') RETURNING verification_status`,
      [ctx.target.employee_id, ctx.target.check_number]);
      expect(inserted.rows[0]!.verification_status).toBe("verified");
    },
  },
  {
    name: "void unnumbered check sharing one recorded period boundary",
    message: /verified or void/,
    arrange: async ctx => { await ctx.pool.query(`INSERT INTO employee_payroll_checks
      (employee_id,period_begin,actual_net,verification_status)
      VALUES ($1,'2026-08-01',80,'void')`, [ctx.target.employee_id]); },
  },
  {
    name: "posted payment allocated by the exact source-link table",
    message: /Posted payment/,
    arrange: async ctx => {
      const otherEmployee = await differentEmployee(ctx), root = await obligation(ctx, {}, otherEmployee);
      await ctx.pool.query(`INSERT INTO settlement_obligation_transactions(settlement_obligation_id,payroll_transaction_id)
        VALUES ($1,$2)`, [root, ctx.target.id]);
      await payment(ctx, root, otherEmployee);
    },
  },
  {
    name: "payment and its reversal on a correction descendant",
    message: /Posted payment/,
    arrange: async ctx => {
      const otherEmployee = await differentEmployee(ctx);
      const root = await obligation(ctx, { sourceTransactionIds: [ctx.target.id] }, otherEmployee);
      const child = await obligation(ctx, { adjustmentForObligationId: root }, otherEmployee);
      const eventId = await payment(ctx, child, otherEmployee);
      await ctx.pool.query(`INSERT INTO settlement_events
        (settlement_obligation_id,employee_id,event_type,amount,occurred_on,reversal_of_event_id)
        VALUES ($1,$2,'reversal',-1,'2026-08-26',$3)`, [child, otherEmployee, eventId]);
    },
  },
  {
    name: "unallocated employee credit with no source provenance",
    message: /Posted payment/,
    arrange: async ctx => { await ctx.pool.query(`INSERT INTO settlement_events(employee_id,event_type,amount,occurred_on)
      VALUES ($1,'credit',1,'2026-08-25')`, [ctx.target.employee_id]); },
  },
  {
    name: "legacy posted history with a nonexistent metadata source",
    message: /Posted payment/,
    arrange: async ctx => {
      const root = await obligation(ctx, { sourceTransactionIds: [randomUUID()], payrollCheckId: randomUUID() });
      await payment(ctx, root);
    },
  },
];

suite("Source-base correction financial history boundaries", () => {
  beforeEach(resetSchema);
  afterAll(closeTestPool);

  for (const guard of guards) for (const phase of ["accept", "undo"] as const) {
    it(`blocks ${phase} for ${guard.name} without changing any source or financial history`, async () => {
      const ctx = await setup(guard.edit);
      let input: Partial<SourceBaseRecoveryInput> = {};
      if (phase === "undo") {
        const accepted = await ctx.action();
        if (!accepted.ok) throw new Error(accepted.message);
        input = { action: "undo", transactionIds: undefined, acceptanceAuditId: accepted.data.acceptanceAuditId };
      }
      await guard.arrange(ctx);
      const before = await controls();
      expect(await ctx.action(input)).toMatchObject({ ok: false, code: "immutable", message: expect.stringMatching(guard.message) });
      expect(await controls()).toEqual(before);
    });
  }

  it("finds Paid history through an unnumbered transitive check bridge", async () => {
    const ctx = await setup(values => {
      values[4]![2] = "";
      const third = [...values[3]!]; third[2] = "OTHER-RECORDED-NUMBER"; third[6] = "300"; third[15] = "252";
      values.push(third);
    });
    await ctx.pool.query("UPDATE payroll_transactions SET is_paid=true,paid_at=now() WHERE id=$1", [ctx.rows[2]!.id]);
    const before = await controls();
    expect(await ctx.action()).toMatchObject({ ok: false, code: "immutable", message: expect.stringContaining("Paid") });
    expect(await controls()).toEqual(before);
  });

  for (const phase of ["accept", "undo"] as const) {
    it(`rolls back ${phase} projections and the dirty trigger after an actual PostgreSQL audit error`, async () => {
      const ctx = await setup();
      let input: Partial<SourceBaseRecoveryInput> = {};
      if (phase === "undo") {
        const accepted = await ctx.action();
        if (!accepted.ok) throw new Error(accepted.message);
        input = { action: "undo", transactionIds: undefined, acceptanceAuditId: accepted.data.acceptanceAuditId };
      }
      const before = await controls();
      let projectionWasWritten = false;
      const failingPool: PgLikePool = {
        query: (sql, params) => ctx.pool.query(sql, params),
        connect: async () => {
          const client = await ctx.pool.connect();
          return {
            query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
              if (/INSERT INTO audit_logs/i.test(sql)) {
                expect(projectionWasWritten).toBe(true);
                return client.query<T>("SELECT 1 / 0");
              }
              const result = await client.query<T>(sql, params);
              if (/UPDATE payroll_transactions t SET calculated_internal_amount/i.test(sql)) projectionWasWritten = true;
              return result;
            },
            release: discard => client.release(discard),
          };
        },
      };
      await expect(ctx.action(input, failingPool)).rejects.toThrow(/division by zero/);
      expect(projectionWasWritten).toBe(true);
      expect(await controls()).toEqual(before);
    });
  }

  it("preserves an unresolved obligation and its review hold while correcting an otherwise safe source", async () => {
    const ctx = await setup(), root = await obligation(ctx, { legacyBasis: "unknown" });
    await ctx.pool.query(`UPDATE settlement_ledger_state SET blocked_obligation_ids=ARRAY[$1::uuid],
      source_review_count=1,source_review_summary='Review the original financial basis',refreshed_version=source_version`, [root]);
    const before = await controls();
    const stateBefore = (await ctx.pool.query<{ source_version: string }>("SELECT source_version::text FROM settlement_ledger_state")).rows[0]!;
    expect(await ctx.action()).toMatchObject({ ok: true, data: { status: "accepted", transactionCount: 1 } });
    const after = await controls();
    expect(Object.keys(before).filter(table => JSON.stringify(before[table]) !== JSON.stringify(after[table])).sort())
      .toEqual(["audit_logs", "payroll_transactions", "settlement_ledger_state"]);
    const stateAfter = (await ctx.pool.query<{ source_version: string; refreshed_version: string; blocked_obligation_ids: string[]; source_review_count: number }>(
      "SELECT source_version::text,refreshed_version::text,blocked_obligation_ids,source_review_count FROM settlement_ledger_state",
    )).rows[0]!;
    expect(BigInt(stateAfter.source_version)).toBe(BigInt(stateBefore.source_version) + 1n);
    expect(stateAfter.refreshed_version).toBe(stateBefore.source_version);
    expect(stateAfter.blocked_obligation_ids).toEqual([root]); expect(stateAfter.source_review_count).toBe(1);
  });
});

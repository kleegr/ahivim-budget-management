import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { normalizePersonName } from "@/lib/business/name-matching";
import { mergeEmployees } from "@/lib/manage/employee-merge";
import { mergeIndividuals } from "@/lib/manage/individual-merge";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";
import { applyChangedConflict, dismissConflict } from "@/lib/sheets/resolve";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000009731";
suite("Changed source rows retain their recorded identity after approved person merges", () => {
  beforeEach(async () => {
    await resetSchema();
    await testPool().query(`INSERT INTO users (id, email, display_name, password_hash, role)
      VALUES ($1, 'merge-drift@example.test', 'Synthetic source reviewer', 'x', 'admin')`, [ACTOR]);
  }, 60_000);
  afterAll(closeTestPool);

  const sync = (values: string[][]) => runSheetSync(testPool(), { trigger: "manual", userId: ACTOR,
    config: DEFAULT_SYNC_CONFIG, fetcher: async () => sheetValuesToCsv(values) });
  const changed = (values: string[][], hours = "101", amount = "3838") => {
    const next = values.map(row => [...row]); next[3]![4] = hours; next[3]![6] = amount; return next;
  };
  const reordered = (values: string[][]) => [...values.slice(0, 3), ...values.slice(3).reverse()];
  async function fixture(kind: "employee" | "individual", sharedNaturalKey = false) {
    const values = (await numericSheetFixture()).values.map(row => [...row]);
    values[3]![7] = "3172.03"; values[4]![7] = "3172.03";
    if (sharedNaturalKey) {
      values[4]![2] = values[3]![2]!; values[4]![4] = "102"; values[4]![6] = "3876";
    }
    expect(await sync(values)).toMatchObject({ status: "success", added: 2 });
    const table = kind === "employee" ? "employees" : "individuals";
    const old = (await testPool().query<{ id: string }>(`SELECT id FROM ${table} WHERE normalized_name=$1`,
      [normalizePersonName(values[3]![kind === "employee" ? 12 : 11]!)])).rows[0]!.id;
    const name = `Synthetic ${kind} survivor`;
    const survivor = (await testPool().query<{ id: string }>(`INSERT INTO ${table} (display_name, normalized_name)
      VALUES ($1, $2) RETURNING id`, [name, normalizePersonName(name)])).rows[0]!.id;
    const merge = kind === "employee" ? mergeEmployees : mergeIndividuals;
    expect(await merge(testPool(), { keepId: survivor, mergeId: old }, ACTOR, "Confirmed synthetic duplicate"))
      .toMatchObject({ ok: true, data: { repointed: { payroll_transactions: 2 } } });
    expect((await testPool().query(`SELECT DISTINCT ${kind}_id AS person_id FROM payroll_transactions`)).rows)
      .toEqual([{ person_id: survivor }]);
    return { values, survivor, kind };
  }
  async function recordedControls() {
    return (await testPool().query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) - 'updated_at' - 'has_source_conflict' - 'sync_review_reason' ORDER BY id) FROM payroll_transactions t) AS payroll,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM import_rows t
        WHERE id IN (SELECT import_row_id FROM payroll_transactions)) AS original_source,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM service_allocations t) AS allocations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM employee_payroll_checks t) AS checks,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_obligations t) AS obligations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_events t) AS events`)).rows[0];
  }

  for (const kind of ["employee", "individual"] as const) {
    for (const action of ["apply", "dismiss"] as const) {
      it(`holds a changed ${kind} source row after its merge, preserves replay, and permits explicit ${action}`, async () => {
        const { values, survivor } = await fixture(kind);
        const before = await recordedControls();
        expect(await sync(values)).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
        expect(await sync(values)).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
        expect(await recordedControls()).toEqual(before);

        const incoming = changed(values);
        expect(await sync(incoming)).toMatchObject({ added: 0, changed: 1, missing: 0 });
        expect(await recordedControls()).toEqual(before);
        const reviews = (await testPool().query<{ id: string; payroll_transaction_id: string }>(
          "SELECT id, payroll_transaction_id FROM sheet_sync_conflicts WHERE status='open' ORDER BY id")).rows;
        expect(reviews).toHaveLength(1);
        let review = reviews[0]!;
        expect(review.payroll_transaction_id).toBeTruthy();
        expect(await sync(incoming)).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
        expect(await sync(reordered(incoming))).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
        expect((await testPool().query("SELECT id FROM sheet_sync_conflicts WHERE status='open'")).rows)
          .toEqual([{ id: review.id }]);
        expect(await recordedControls()).toEqual(before);

        // An unrelated source Paid marker changes the source snapshot and
        // forces full reconciliation while application-owned Paid stays put.
        const fresh = incoming.map(row => [...row]); fresh[4]![13] = "Paid";
        expect(await sync(fresh)).toMatchObject({ added: 0, changed: 1, missing: 0 });
        const currentReviews = (await testPool().query<{ id: string; payroll_transaction_id: string }>(
          "SELECT id, payroll_transaction_id FROM sheet_sync_conflicts WHERE status='open'")).rows;
        expect(currentReviews).toHaveLength(1);
        expect(currentReviews[0]!.payroll_transaction_id).toBe(review.payroll_transaction_id);
        review = currentReviews[0]!;
        expect(await recordedControls()).toEqual(before);

        const resolution = action === "apply"
          ? await applyChangedConflict(testPool(), review.id, ACTOR,
            { config: DEFAULT_SYNC_CONFIG, fetcher: async () => sheetValuesToCsv(fresh) })
          : await dismissConflict(testPool(), review.id, ACTOR, "Keep the recorded figures after source review");
        expect(resolution).toMatchObject({ ok: true });
        const rows = (await testPool().query(`SELECT id, ${kind}_id AS person_id, imported_hours::text AS hours,
          imported_amount::text AS amount, total_net_pay::text AS net, is_paid FROM payroll_transactions ORDER BY id`)).rows;
        expect(rows).toHaveLength(2);
        expect(rows.every(row => row.person_id === survivor && row.net === "3172.0300" && row.is_paid === false)).toBe(true);
        expect(rows.find(row => row.id === review.payroll_transaction_id)).toMatchObject({
          hours: action === "apply" ? "101.0000" : "100.0000",
          amount: action === "apply" ? "3838.0000" : "3800.0000",
        });
        const accepted = await recordedControls();
        expect(accepted!.original_source).toEqual(before!.original_source);
        expect(accepted!.checks).toEqual(before!.checks);
        expect(accepted!.obligations).toEqual(before!.obligations);
        expect(accepted!.events).toEqual(before!.events);
        expect(await sync(incoming)).toMatchObject({ added: 0, changed: 0, missing: 0 });
        expect(await sync(reordered(incoming))).toMatchObject({ added: 0, changed: 0, missing: 0 });
        expect(await recordedControls()).toEqual(accepted);
        expect((await testPool().query("SELECT count(*)::int AS count FROM sheet_sync_conflicts WHERE status='open'")).rows[0]?.count).toBe(0);
      }, 40_000);
    }
  }

  it("keeps two distinct transactions claiming the same tracked source natural key ambiguous", async () => {
    const { values } = await fixture("employee", true);
    const before = await recordedControls();
    const result = await sync(changed(values));
    expect(result).toMatchObject({ added: 0, changed: 1 });
    expect(await recordedControls()).toEqual(before);
    const reviews = (await testPool().query<{ id: string; payroll_transaction_id: string | null; previous: { candidateCount: number } }>(
      "SELECT id, payroll_transaction_id, previous FROM sheet_sync_conflicts WHERE status='open' AND type='changed'")).rows;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ payroll_transaction_id: null, previous: { candidateCount: 2 } });
    expect(await applyChangedConflict(testPool(), reviews[0]!.id, ACTOR,
      { config: DEFAULT_SYNC_CONFIG, fetcher: async () => sheetValuesToCsv(changed(values)) }))
      .toMatchObject({ ok: false });
    expect(await recordedControls()).toEqual(before);
  }, 40_000);
});

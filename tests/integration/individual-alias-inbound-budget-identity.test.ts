import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { normalizePersonName } from "@/lib/business/name-matching";
import { listProgramBudgets } from "@/lib/data/program-budgets";
import { commitStagedImport, type CommitInput, type PgLikePool } from "@/lib/import/commit";
import { loadStagingContext } from "@/lib/import/pipeline";
import { stageRows } from "@/lib/import/stage";
import { createProgramBudget } from "@/lib/manage/program-budgets";
import { mergeIndividuals } from "@/lib/manage/individual-merge";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000009701";
suite("Individual source identity reaches the correct budget after alias approval and merge", () => {
  beforeEach(async () => {
    await resetSchema();
    await testPool().query(`INSERT INTO users (id, email, display_name, password_hash, role)
      VALUES ($1, 'individual-identity@example.test', 'Synthetic identity operator', 'x', 'admin')`, [ACTOR]);
  }, 60_000);
  afterAll(closeTestPool);

  async function individual(name: string) {
    return (await testPool().query<{ id: string }>(`INSERT INTO individuals (display_name, normalized_name)
      VALUES ($1, $2) RETURNING id`, [name, normalizePersonName(name)])).rows[0]!.id;
  }
  async function budget(individualId: string, hours: string) {
    const program = (await testPool().query<{ id: string }>("SELECT id FROM programs WHERE code = 'SH_COM_HAB'")).rows[0]!;
    const result = await createProgramBudget(testPool(), { individualId, programId: program.id,
      renewalDate: "2027-01-01", authorizedHours: hours }, ACTOR);
    if (!result.ok) throw new Error(result.message);
    return result.data;
  }
  async function alias(name: string, id: string, status = "approved") {
    await testPool().query(`INSERT INTO individual_aliases (individual_id, source_text, normalized_alias, status)
      VALUES ($1, $2, $3, $4)`, [id, name, normalizePersonName(name), status]);
  }
  async function inputFor(csv: string): Promise<CommitInput> {
    const parsed = parseSheetCsv(csv), context = await loadStagingContext(testPool());
    return { checksumSha256: parsed.snapshotSha256, originalFilename: "synthetic-individual-identity.csv",
      byteSize: Buffer.byteLength(csv), templateDetected: "ahivim_v1", sheetSummary: {}, parsedRows: parsed.ahivimRows,
      staging: stageRows(parsed.ahivimRows, context), ratesByProgram: context.ratesByProgram, committedByUserId: ACTOR };
  }
  async function controls() {
    const result: Record<string, unknown> = {};
    for (const table of ["individuals", "individual_aliases", "budget_periods", "budget_authorizations",
      "payroll_transactions", "import_rows", "import_batches", "imported_files", "service_sessions", "service_allocations",
      "employee_payroll_checks", "settlement_obligations", "settlement_events", "settlement_ledger_state", "audit_logs"]) {
      result[table] = (await testPool().query(`SELECT count(*)::int AS count,
        md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), '')) AS hash FROM ${table} t`)).rows[0];
    }
    return result;
  }

  it("uses the approved individual alias ID for imported source, payroll, allocation and canonical budget usage", async () => {
    const fixture = await numericSheetFixture();
    const target = await individual("Canonical Synthetic Individual");
    await budget(target, "300");
    const name = fixture.values[3]![11]!;
    await testPool().query(`INSERT INTO individual_aliases (individual_id, source_text, normalized_alias, status)
      VALUES ($1, $2, $3, 'approved')`, [target, name, normalizePersonName(name)]);
    const parsed = parseSheetCsv(fixture.csv), context = await loadStagingContext(testPool());
    const priorCount = (await testPool().query("SELECT count(*)::int AS count FROM individuals")).rows[0]!.count;
    const staging = stageRows(parsed.ahivimRows, context);
    expect(staging.rows.every(row => row.status === "valid" && row.individualId === target)).toBe(true);
    expect(await commitStagedImport(testPool(), { checksumSha256: parsed.snapshotSha256,
      originalFilename: "synthetic-individual-alias.csv", byteSize: Buffer.byteLength(fixture.csv),
      templateDetected: "ahivim_v1", sheetSummary: {}, parsedRows: parsed.ahivimRows,
      staging, ratesByProgram: context.ratesByProgram, committedByUserId: ACTOR }))
      .toMatchObject({ counts: { transactions: 2, individualsCreated: 0 } });
    const rows = (await testPool().query(`SELECT t.individual_id, r.resolved_individual_id,
      a.individual_id AS allocation_individual_id FROM payroll_transactions t
      JOIN import_rows r ON r.id = t.import_row_id
      JOIN service_allocations a ON a.payroll_transaction_id = t.id ORDER BY t.id`)).rows;
    expect.soft(rows).toHaveLength(2);
    expect.soft(rows.every(row => row.individual_id === target && row.resolved_individual_id === target
      && row.allocation_individual_id === target)).toBe(true);
    expect.soft((await listProgramBudgets(testPool(), { individualId: target }))[0])
      .toMatchObject({ consumedHours: "200.0000", remainingHours: "100.0000" });
    expect.soft((await testPool().query("SELECT count(*)::int AS count FROM individuals")).rows[0]?.count).toBe(priorCount);
  }, 40_000);

  it("keeps unchanged syncs stable and assigns a new old-spelling source row to the audited individual survivor's budget", async () => {
    const fixture = await numericSheetFixture(), pool = testPool();
    const sync = (csv = fixture.csv) => runSheetSync(pool, { trigger: "manual", userId: ACTOR,
      config: DEFAULT_SYNC_CONFIG, fetcher: async () => csv });
    expect(await sync()).toMatchObject({ status: "success", added: 2 });
    expect((await pool.query("SELECT metadata->'counts' AS counts FROM audit_logs WHERE action = 'import.commit'")).rows[0]?.counts)
      .toMatchObject({ individualsCreated: 1 });
    const old = (await pool.query<{ id: string }>("SELECT id FROM individuals WHERE normalized_name=$1",
      [normalizePersonName(fixture.values[3]![11]!)])).rows[0]!.id;
    const survivor = await individual("Audited Synthetic Individual Survivor");
    await budget(survivor, "300");
    expect(await mergeIndividuals(pool, { keepId: survivor, mergeId: old }, ACTOR, "Confirmed duplicate synthetic individual"))
      .toMatchObject({ ok: true });
    expect((await pool.query("SELECT status, merged_into_id FROM individuals WHERE id=$1", [old])).rows[0])
      .toEqual({ status: "archived", merged_into_id: survivor });
    const prior = (await pool.query("SELECT id, individual_id, total_net_pay, is_paid FROM payroll_transactions ORDER BY id")).rows;
    expect(prior.every(row => row.individual_id === survivor)).toBe(true);
    expect(await sync()).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect(await sync()).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect((await pool.query("SELECT id, individual_id, total_net_pay, is_paid FROM payroll_transactions ORDER BY id")).rows).toEqual(prior);
    const values = fixture.values.map(row => [...row]);
    const next = [...values[3]!]; next[2] = "NEW-INDIVIDUAL-CHECK-AFTER-MERGE"; values.push(next);
    expect(await sync(sheetValuesToCsv(values))).toMatchObject({ status: "success", added: 1, changed: 0 });
    const added = (await pool.query(`SELECT t.individual_id, i.status, r.resolved_individual_id,
      a.individual_id AS allocation_individual_id FROM payroll_transactions t
      JOIN individuals i ON i.id = t.individual_id JOIN import_rows r ON r.id = t.import_row_id
      JOIN service_allocations a ON a.payroll_transaction_id = t.id
      WHERE t.check_number = 'NEW-INDIVIDUAL-CHECK-AFTER-MERGE'`)).rows;
    expect.soft(added).toEqual([{ individual_id: survivor, status: "active",
      resolved_individual_id: survivor, allocation_individual_id: survivor }]);
    expect.soft((await listProgramBudgets(pool, { individualId: survivor }))[0])
      .toMatchObject({ consumedHours: "300.0000", remainingHours: "0.0000" });
    expect((await pool.query(`SELECT metadata->'counts' AS counts FROM audit_logs
      WHERE action = 'import.commit' ORDER BY created_at DESC LIMIT 1`)).rows[0]?.counts).toMatchObject({ individualsCreated: 0 });
    const afterNew = await controls();
    expect(await sync(sheetValuesToCsv(values))).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect(await sync(sheetValuesToCsv(values))).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect(await controls()).toEqual(afterNew);
  }, 40_000);

  for (const defect of ["missing_audit", "null_pointer", "wrong_pointer", "pending_alias"] as const) {
    it(`holds incomplete archived individual merge evidence (${defect}) without assigning source hours to either budget`, async () => {
      const fixture = await numericSheetFixture(), name = fixture.values[3]![11]!;
      const old = await individual(name), survivor = await individual("Synthetic Intended Survivor");
      await budget(survivor, "300");
      if (defect === "missing_audit") {
        await alias(name, survivor);
        await testPool().query("UPDATE individuals SET status='archived', archived_at=now(), merged_into_id=$2 WHERE id=$1", [old, survivor]);
      } else {
        expect(await mergeIndividuals(testPool(), { keepId: survivor, mergeId: old }, ACTOR, "Synthetic recorded merge"))
          .toMatchObject({ ok: true });
        if (defect === "pending_alias") {
          await testPool().query("UPDATE individual_aliases SET status='pending' WHERE normalized_alias=$1", [normalizePersonName(name)]);
        } else {
          const pointer = defect === "null_pointer" ? null : await individual("Different Synthetic Pointer");
          await testPool().query("UPDATE individuals SET merged_into_id=$2 WHERE id=$1", [old, pointer]);
        }
      }
      const input = await inputFor(fixture.csv);
      expect(input.staging.rows.every(row => row.status === "needs_review" && row.individualId === null)).toBe(true);
      expect(input.staging.warnings.filter(warning => warning.category === "ambiguous_name")).toHaveLength(2);
      expect(await commitStagedImport(testPool(), input)).toMatchObject({ counts: { transactions: 0, individualsCreated: 0, reviewRows: 2 } });
      expect((await testPool().query("SELECT status, resolved_individual_id FROM import_rows ORDER BY source_row_number")).rows)
        .toEqual([{ status: "needs_review", resolved_individual_id: null }, { status: "needs_review", resolved_individual_id: null }]);
      expect((await listProgramBudgets(testPool(), { individualId: survivor }))[0])
        .toMatchObject({ consumedHours: "0.0000", remainingHours: "300.0000" });
      expect((await testPool().query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]?.count).toBe(0);
    }, 40_000);
  }

  it("keeps a legitimate archived individual with no merge canonical for its recorded budget history", async () => {
    const fixture = await numericSheetFixture(), old = await individual(fixture.values[3]![11]!);
    await budget(old, "300");
    await testPool().query("UPDATE individuals SET status='archived', archived_at=now() WHERE id=$1", [old]);
    const input = await inputFor(fixture.csv);
    expect(input.staging.rows.every(row => row.status === "valid" && row.individualId === old)).toBe(true);
    expect(await commitStagedImport(testPool(), input)).toMatchObject({ counts: { transactions: 2, individualsCreated: 0 } });
    expect((await listProgramBudgets(testPool(), { individualId: old }))[0])
      .toMatchObject({ consumedHours: "200.0000", remainingHours: "100.0000" });
  }, 40_000);

  it("preserves pending aliases and fuzzy match review notes without silently applying either identity", async () => {
    const fixture = await numericSheetFixture(), name = fixture.values[3]![11]!;
    const suggested = await individual("Synthetic Numeric Individuals");
    await budget(suggested, "300"); await alias(name, suggested, "pending");
    const input = await inputFor(fixture.csv);
    expect(input.staging.rows.every(row => row.individualId === null && row.status === "valid")).toBe(true);
    const warnings = input.staging.warnings.filter(warning => warning.category === "unmatched_individual");
    expect(warnings).toHaveLength(2);
    expect(warnings.every(warning => Number(warning.details?.suggestionCount) > 0)).toBe(true);
    expect(await commitStagedImport(testPool(), input)).toMatchObject({ counts: { transactions: 2, individualsCreated: 1 } });
    const ids = (await testPool().query("SELECT DISTINCT individual_id FROM payroll_transactions")).rows;
    expect(ids).toHaveLength(1); expect(ids[0]?.individual_id).not.toBe(suggested);
    expect((await listProgramBudgets(testPool(), { individualId: suggested }))[0])
      .toMatchObject({ consumedHours: "0.0000", remainingHours: "300.0000" });
    expect((await testPool().query("SELECT status FROM individual_aliases WHERE individual_id=$1", [suggested])).rows)
      .toEqual([{ status: "pending" }]);
  }, 40_000);

  it("rejects a stale approved individual alias before any import or budget write and permits a fresh review", async () => {
    const fixture = await numericSheetFixture(), name = fixture.values[3]![11]!;
    const first = await individual("First Canonical Individual"), second = await individual("Second Canonical Individual");
    await budget(first, "300"); await budget(second, "300"); await alias(name, first);
    const input = await inputFor(fixture.csv);
    expect(input.staging.rows.every(row => row.individualId === first)).toBe(true);
    await testPool().query("UPDATE individual_aliases SET individual_id=$1 WHERE normalized_alias=$2", [second, normalizePersonName(name)]);
    const before = await controls();
    await expect(commitStagedImport(testPool(), input)).rejects.toThrow("Individual identity changed or needs review on source row");
    expect(await controls()).toEqual(before);
    const fresh = await inputFor(fixture.csv);
    expect(fresh.staging.rows.every(row => row.individualId === second)).toBe(true);
    expect(await commitStagedImport(testPool(), fresh)).toMatchObject({ counts: { transactions: 2, individualsCreated: 0 } });
    expect((await listProgramBudgets(testPool(), { individualId: first }))[0])
      .toMatchObject({ consumedHours: "0.0000", remainingHours: "300.0000" });
    expect((await listProgramBudgets(testPool(), { individualId: second }))[0])
      .toMatchObject({ consumedHours: "200.0000", remainingHours: "100.0000" });
  }, 40_000);

  it("serializes an actual alias reassignment after the locked directory read and preserves the original budget assignment", async () => {
    const fixture = await numericSheetFixture(), name = fixture.values[3]![11]!, pool = testPool();
    const first = await individual("Initial Canonical Individual"), second = await individual("Later Canonical Individual");
    await budget(first, "300"); await budget(second, "300"); await alias(name, first);
    const input = await inputFor(fixture.csv);
    let directoryRead!: () => void, releaseImport!: () => void;
    const read = new Promise<void>(resolve => { directoryRead = resolve; });
    const hold = new Promise<void>(resolve => { releaseImport = resolve; });
    const gated: PgLikePool = { query: (sql, params) => pool.query(sql, params), connect: async () => {
      const client = await pool.connect();
      return { query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await client.query<T>(sql, params);
        if (sql.includes("FROM individuals) AS people")) { directoryRead(); await hold; }
        return result;
      }, release: error => client.release(error) };
    } };
    const writer = await pool.connect();
    const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const importing = commitStagedImport(gated, input);
    let writing: Promise<unknown> | undefined;
    try {
      await Promise.race([read, importing.then(() => { throw new Error("Import finished before the guarded directory read"); })]);
      writing = writer.query("UPDATE individual_aliases SET individual_id=$1 WHERE normalized_alias=$2", [second, normalizePersonName(name)]);
      await expect.poll(async () => (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type,
        { timeout: 5000, interval: 25 }).toBe("Lock");
      expect((await pool.query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]?.count).toBe(0);
      releaseImport();
      expect(await importing).toMatchObject({ counts: { transactions: 2, individualsCreated: 0 } }); await writing;
      expect((await pool.query("SELECT DISTINCT individual_id FROM payroll_transactions")).rows).toEqual([{ individual_id: first }]);
      expect((await listProgramBudgets(pool, { individualId: first }))[0])
        .toMatchObject({ consumedHours: "200.0000", remainingHours: "100.0000" });
      expect((await listProgramBudgets(pool, { individualId: second }))[0])
        .toMatchObject({ consumedHours: "0.0000", remainingHours: "300.0000" });
      expect((await inputFor(fixture.csv)).staging.rows.every(row => row.individualId === second)).toBe(true);
    } finally {
      releaseImport(); await importing.catch(() => {}); await writing?.catch(() => {}); writer.release();
    }
  }, 40_000);
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { normalizePersonName } from "@/lib/business/name-matching";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";
import { runSheetSync } from "@/lib/sheets/sync";
import { mergeEmployees } from "@/lib/manage/employee-merge";
import { loadStagingContext } from "@/lib/import/pipeline";
import { stageRows } from "@/lib/import/stage";
import { commitStagedImport, type CommitInput, type PgLikePool } from "@/lib/import/commit";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;
suite("New inbound source rows after an audited employee merge", () => {
  beforeEach(resetSchema, 60_000);
  afterAll(closeTestPool);

  async function employee(name: string, status = "active") {
    return (await testPool().query<{ id: string }>(`INSERT INTO employees (display_name, normalized_name, status)
      VALUES ($1, $2, $3) RETURNING id`, [name, normalizePersonName(name), status])).rows[0]!.id;
  }
  async function alias(name: string, target: string, status = "approved") {
    await testPool().query(`INSERT INTO employee_aliases (employee_id, source_text, normalized_alias, status)
      VALUES ($1, $2, $3, $4)`, [target, name, normalizePersonName(name), status]);
  }
  async function stagedInput(csv: string): Promise<CommitInput> {
    const parsed = parseSheetCsv(csv), context = await loadStagingContext(testPool());
    return { checksumSha256: parsed.snapshotSha256, originalFilename: "synthetic-employee-identity.csv",
      byteSize: Buffer.byteLength(csv), templateDetected: "ahivim_v1", sheetSummary: {},
      parsedRows: parsed.ahivimRows, staging: stageRows(parsed.ahivimRows, context),
      ratesByProgram: context.ratesByProgram, committedByUserId: null };
  }
  async function controls() {
    return (await testPool().query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payroll_transactions t) AS payroll,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM import_rows t) AS source,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM imported_files t) AS files,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM service_sessions t) AS sessions,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM employee_payroll_checks t) AS checks,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_obligations t) AS obligations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_events t) AS events,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM audit_logs t) AS audits,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM employees t) AS employees`)).rows[0];
  }

  it("retains deduplication on unchanged syncs and assigns a genuinely new old-spelling row to the audited survivor", async () => {
    const pool = testPool(), fixture = await numericSheetFixture();
    const sync = (csv = fixture.csv) => runSheetSync(pool, { trigger: "manual", userId: null,
      config: DEFAULT_SYNC_CONFIG, fetcher: async () => csv });
    expect(await sync()).toMatchObject({ status: "success", added: 2 });
    expect((await pool.query(`SELECT (metadata#>>'{counts,employeesCreated}')::int AS created
      FROM audit_logs WHERE action = 'import.commit' ORDER BY created_at DESC LIMIT 1`)).rows[0]?.created).toBe(1);
    const oldEmployee = (await pool.query<{ id: string }>("SELECT id FROM employees")).rows[0]!.id;
    const survivor = (await pool.query<{ id: string }>(`INSERT INTO employees (display_name, normalized_name)
      VALUES ('Synthetic Surviving Employee', $1) RETURNING id`, [normalizePersonName("Synthetic Surviving Employee")])).rows[0]!.id;
    expect(await mergeEmployees(pool, { keepId: survivor, mergeId: oldEmployee }, null, "Confirmed duplicate employee fixture"))
      .toMatchObject({ ok: true, data: { repointed: { payroll_transactions: 2 } } });
    expect((await pool.query("SELECT status FROM employees WHERE id = $1", [oldEmployee])).rows[0]?.status).toBe("archived");
    const existing = (await pool.query("SELECT id, employee_id, total_net_pay, is_paid FROM payroll_transactions ORDER BY id")).rows;
    expect(existing).toHaveLength(2);
    expect(existing.every(row => row.employee_id === survivor)).toBe(true);
    expect(await sync()).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect(await sync()).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect((await pool.query("SELECT id, employee_id, total_net_pay, is_paid FROM payroll_transactions ORDER BY id")).rows).toEqual(existing);

    const values = fixture.values.map(row => [...row]);
    const newRow = [...values[3]!]; newRow[2] = "NEW-CHECK-AFTER-AUDITED-MERGE"; values.push(newRow);
    const changed = await sync(sheetValuesToCsv(values));
    expect(changed).toMatchObject({ status: "success", added: 1, changed: 0 });
    expect((await pool.query(`SELECT (metadata#>>'{counts,employeesCreated}')::int AS created
      FROM audit_logs WHERE action = 'import.commit' ORDER BY created_at DESC LIMIT 1`)).rows[0]?.created).toBe(0);
    const added = (await pool.query(`SELECT p.employee_id, e.status AS employee_status,
      r.resolved_employee_id, p.total_net_pay, p.is_paid FROM payroll_transactions p
      JOIN employees e ON e.id = p.employee_id JOIN import_rows r ON r.id = p.import_row_id
      WHERE p.check_number = 'NEW-CHECK-AFTER-AUDITED-MERGE'`)).rows[0];
    expect(added).toEqual({ employee_id: survivor, employee_status: "active", resolved_employee_id: survivor,
      total_net_pay: null, is_paid: false });
    const afterNew = await controls();
    expect(await sync(sheetValuesToCsv(values))).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect(await sync(sheetValuesToCsv(values))).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
    expect(await controls()).toEqual(afterNew);
    expect((await pool.query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]?.count).toBe(3);
  }, 40_000);

  it("persists a normal approved alias's existing employee ID rather than creating a second person from the raw spelling", async () => {
    const fixture = await numericSheetFixture(), target = await employee("Canonical Synthetic Employee");
    await alias(fixture.values[3]![12]!, target);
    const input = await stagedInput(fixture.csv);
    expect(input.staging.rows.every(row => row.employeeId === target)).toBe(true);
    expect(await commitStagedImport(testPool(), input)).toMatchObject({ counts: { transactions: 2, employeesCreated: 0 } });
    expect((await testPool().query("SELECT DISTINCT employee_id FROM payroll_transactions")).rows).toEqual([{ employee_id: target }]);
    expect((await testPool().query("SELECT count(*)::int AS count FROM employees")).rows[0]?.count).toBe(1);
  }, 40_000);

  it("keeps a legitimate archived person canonical when no merge or contradictory alias exists", async () => {
    const fixture = await numericSheetFixture(), archived = await employee(fixture.values[3]![12]!, "archived");
    const input = await stagedInput(fixture.csv);
    expect(input.staging.rows.every(row => row.employeeId === archived)).toBe(true);
    expect(await commitStagedImport(testPool(), input)).toMatchObject({ counts: { transactions: 2 } });
    expect((await testPool().query("SELECT DISTINCT employee_id FROM payroll_transactions")).rows).toEqual([{ employee_id: archived }]);
  }, 40_000);

  for (const aliasState of ["pending", "missing"] as const) {
    it(`holds new payroll for a recorded employee merge whose approval alias is ${aliasState}`, async () => {
      const fixture = await numericSheetFixture(), pool = testPool();
      const old = await employee(fixture.values[3]![12]!), survivor = await employee("Recorded Synthetic Survivor");
      expect(await mergeEmployees(pool, { keepId: survivor, mergeId: old }, null, "Confirmed duplicate fixture"))
        .toMatchObject({ ok: true });
      if (aliasState === "missing") await pool.query("DELETE FROM employee_aliases WHERE employee_id = $1", [survivor]);
      else await pool.query("UPDATE employee_aliases SET status = 'pending' WHERE employee_id = $1", [survivor]);
      const input = await stagedInput(fixture.csv);
      expect(input.staging.rows.every(row => row.status === "needs_review" && row.employeeId === null)).toBe(true);
      expect(await commitStagedImport(pool, input)).toMatchObject({ counts: { transactions: 0, reviewRows: 2, employeesCreated: 0 } });
      expect((await pool.query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]?.count).toBe(0);
      expect((await pool.query("SELECT status, resolved_employee_id FROM import_rows ORDER BY source_row_number")).rows)
        .toEqual([{ status: "needs_review", resolved_employee_id: null }, { status: "needs_review", resolved_employee_id: null }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action = 'employees_merged'")).rows[0]?.count).toBe(1);
    }, 40_000);
  }

  it("preserves an archived-name/approved-alias collision without a merge audit as visible source review", async () => {
    const fixture = await numericSheetFixture();
    await employee(fixture.values[3]![12]!, "archived");
    await alias(fixture.values[3]![12]!, await employee("Unproven Synthetic Survivor"));
    const input = await stagedInput(fixture.csv);
    expect(input.staging.rows.every(row => row.status === "needs_review" && row.employeeId === null)).toBe(true);
    expect(input.staging.warnings.filter(w => w.category === "ambiguous_name")).toHaveLength(2);
    expect(await commitStagedImport(testPool(), input)).toMatchObject({ counts: { transactions: 0, reviewRows: 2 } });
    expect((await testPool().query("SELECT status, resolved_employee_id FROM import_rows ORDER BY source_row_number")).rows)
      .toEqual([{ status: "needs_review", resolved_employee_id: null }, { status: "needs_review", resolved_employee_id: null }]);
    expect((await testPool().query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]?.count).toBe(0);
  }, 40_000);

  for (const change of ["alias_rematch", "audited_merge"] as const) {
    it(`rejects a stale staged employee ID after ${change} before any import writes`, async () => {
      const fixture = await numericSheetFixture(), sourceName = fixture.values[3]![12]!;
      const first = await employee(change === "audited_merge" ? sourceName : "First Canonical Employee");
      const second = await employee("Second Canonical Employee");
      if (change === "alias_rematch") await alias(sourceName, first);
      const input = await stagedInput(fixture.csv);
      expect(input.staging.rows.every(row => row.employeeId === first)).toBe(true);
      if (change === "alias_rematch") await testPool().query("UPDATE employee_aliases SET employee_id = $1", [second]);
      else expect(await mergeEmployees(testPool(), { keepId: second, mergeId: first }, null, "Confirmed duplicate fixture")).toMatchObject({ ok: true });
      const before = await controls();
      await expect(commitStagedImport(testPool(), input)).rejects.toThrow("Employee identity changed or needs review on source row");
      expect(await controls()).toEqual(before);
      const refreshed = await stagedInput(fixture.csv);
      expect(refreshed.staging.rows.every(row => row.employeeId === second)).toBe(true);
      expect(await commitStagedImport(testPool(), refreshed)).toMatchObject({ counts: { transactions: 2 } });
      expect((await testPool().query("SELECT DISTINCT employee_id FROM payroll_transactions")).rows).toEqual([{ employee_id: second }]);
    }, 40_000);
  }

  it("preserves pending-alias and fuzzy suggestions without treating them as an approved employee identity", async () => {
    const fixture = await numericSheetFixture(), sourceName = fixture.values[3]![12]!;
    const suggested = await employee("Synthetic Numeric Employees");
    await alias(sourceName, suggested, "pending");
    const input = await stagedInput(fixture.csv);
    expect(input.staging.rows.every(row => row.employeeId === null)).toBe(true);
    expect(input.staging.warnings.filter(w => w.category === "unmatched_employee")).toHaveLength(2);
    expect(await commitStagedImport(testPool(), input)).toMatchObject({ counts: { transactions: 2, employeesCreated: 1 } });
    const ids = (await testPool().query("SELECT DISTINCT employee_id FROM payroll_transactions")).rows;
    expect(ids).toHaveLength(1); expect(ids[0]?.employee_id).not.toBe(suggested);
    expect((await testPool().query("SELECT status FROM employee_aliases")).rows).toEqual([{ status: "pending" }]);
  }, 40_000);

  it("blocks a concurrent approved-alias reassignment until the resolved import commits, then uses the new identity for later review", async () => {
    const fixture = await numericSheetFixture(), sourceName = fixture.values[3]![12]!;
    const first = await employee("Initial Canonical Employee"), second = await employee("Later Canonical Employee");
    await alias(sourceName, first);
    const input = await stagedInput(fixture.csv), pool = testPool();
    let directoryRead!: () => void, releaseImport!: () => void;
    const read = new Promise<void>(resolve => { directoryRead = resolve; });
    const hold = new Promise<void>(resolve => { releaseImport = resolve; });
    const gated: PgLikePool = { query: (sql, params) => pool.query(sql, params), connect: async () => {
      const client = await pool.connect();
      return { query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await client.query<T>(sql, params);
        if (sql.includes("'mergedId', metadata->>'mergedId'")) { directoryRead(); await hold; }
        return result;
      }, release: error => client.release(error) };
    } };
    const writer = await pool.connect();
    const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const importing = commitStagedImport(gated, input);
    let writing: Promise<unknown> | undefined;
    try {
      await Promise.race([read, importing.then(() => { throw new Error("Import finished before the guarded directory read"); })]);
      writing = writer.query("UPDATE employee_aliases SET employee_id = $1", [second]);
      await expect.poll(async () => (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.wait_event_type,
        { timeout: 5000, interval: 25 }).toBe("Lock");
      expect((await pool.query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]?.count).toBe(0);
      releaseImport();
      expect(await importing).toMatchObject({ counts: { transactions: 2 } });
      await writing;
      expect((await pool.query("SELECT DISTINCT employee_id FROM payroll_transactions")).rows).toEqual([{ employee_id: first }]);
      const later = await stagedInput(fixture.csv);
      expect(later.staging.rows.every(row => row.employeeId === second)).toBe(true);
      expect((await pool.query("SELECT count(*)::int AS count FROM employees")).rows[0]?.count).toBe(2);
    } finally {
      releaseImport(); await importing.catch(() => {}); await writing?.catch(() => {}); writer.release();
    }
  }, 40_000);
});

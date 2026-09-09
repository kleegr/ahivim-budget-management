import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { fullAccess } from "@/lib/auth/access";
import { previewBulkResponsibility, saveBulkResponsibility } from "@/lib/manage/bulk-responsibility";
import { saveOperationalResponsibility } from "@/lib/manage/operational-responsibility";
const suite = hasTestDatabase ? describe : describe.skip;
const actor = randomUUID(), first = randomUUID(), second = randomUUID(), employee = randomUUID();
const scope = fullAccess(actor, "admin");
let program: string;
const unwrap = <T>(value: { ok: true; data: T } | { ok: false; message: string }): T => { if (!value.ok) throw new Error(value.message); return value.data; };
suite("atomic responsibility batches on disposable PostgreSQL", () => {
  beforeAll(async () => {
    await resetSchema();
    await testPool().query("INSERT INTO users(id,email,display_name,password_hash,role) VALUES($1,'bulk@test.invalid','Owner','x','admin')", [actor]);
    await testPool().query("INSERT INTO individuals(id,normalized_name,display_name) VALUES($1,'bulk one','Bulk One'),($2,'bulk two','Bulk Two')", [first, second]);
    await testPool().query("INSERT INTO employees(id,normalized_name,display_name) VALUES($1,'bulk worker','Bulk Worker')", [employee]);
    program = (await testPool().query<{ id: string }>("SELECT id FROM programs WHERE code = 'COM_HAB'")).rows[0].id;
  }, 60_000);
  afterAll(closeTestPool);
  it("freezes records, preserves specific overrides and agency history, audits each person, and retries once", async () => {
    const pool = testPool();
    unwrap(await saveOperationalResponsibility(pool, "individual", first, { field: "budget", programId: program, value: "unmanaged" }, actor));
    const memberships = (await pool.query("SELECT * FROM agency_individuals ORDER BY id")).rows;
    const targets = unwrap(await previewBulkResponsibility(pool, scope, [first, second]));
    const input = { batchId: randomUUID(), targets: targets.map(({ id, version }) => ({ id, version })), changes: { general: "managed" }, reason: "Synthetic selected responsibility update" };
    expect(unwrap(await saveBulkResponsibility(pool, scope, input, actor))).toMatchObject({ count: 2, repeated: false });
    const actual = unwrap(await previewBulkResponsibility(pool, scope, [first, second]));
    expect(actual.every((row) => row.general === "managed")).toBe(true);
    expect(actual.find((row) => row.id === first)?.programs[program]).toBe("unmanaged");
    expect((await pool.query("SELECT * FROM agency_individuals ORDER BY id")).rows).toEqual(memberships);
    expect(unwrap(await saveBulkResponsibility(pool, scope, input, actor))).toMatchObject({ count: 2, repeated: true });
    expect((await pool.query("SELECT entity_id, metadata->'previous' AS previous, metadata->'next' AS next, reason FROM audit_logs WHERE action='operational_responsibility_changed' AND metadata->>'batchId'=$1", [input.batchId])).rows).toHaveLength(2);
    expect(await saveBulkResponsibility(pool, scope, { ...input, changes: { general: "unmanaged" } }, actor)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("rejects an entire stale batch and preserves the other target", async () => {
    const targets = unwrap(await previewBulkResponsibility(testPool(), scope, [first, second]));
    await testPool().query("UPDATE individuals SET updated_at=now() WHERE id=$1", [second]);
    expect(await saveBulkResponsibility(testPool(), scope, { batchId: randomUUID(), targets, changes: { general: "unmanaged" }, reason: "Stale rehearsal" }, actor)).toMatchObject({ ok: false, code: "conflict" });
    expect(unwrap(await previewBulkResponsibility(testPool(), scope, [first]))[0].general).toBe("managed");
  });
  it("rejects unauthorized targets, blank fields, unrelated money edits and oversized selections", async () => {
    const restricted = { ...scope, full: false, allIndividuals: false, individualIds: [first], grantedIndividualIds: [first] };
    expect(await previewBulkResponsibility(testPool(), restricted, [first, second])).toMatchObject({ ok: false, code: "forbidden" });
    expect(await previewBulkResponsibility(testPool(), scope, Array.from({ length: 101 }, () => randomUUID()))).toMatchObject({ ok: false, code: "validation" });
    const targets = unwrap(await previewBulkResponsibility(testPool(), scope, [first]));
    for (const changes of [{ general: "" }, { dollars: "1000" }, {}]) {
      expect(await saveBulkResponsibility(testPool(), scope, { batchId: randomUUID(), targets, changes, reason: "Invalid fields" }, actor)).toMatchObject({ ok: false, code: "validation" });
    }
  });
  it("rolls back both targets if their audit cannot be committed", async () => {
    const pool = testPool();
    const targets = unwrap(await previewBulkResponsibility(pool, scope, [first, second]));
    await pool.query(`CREATE FUNCTION reject_bulk_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'operational_responsibility_changed' AND NEW.metadata ? 'batchId' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER reject_bulk_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_bulk_test_audit()");
    try { await expect(saveBulkResponsibility(pool, scope, { batchId: randomUUID(), targets, changes: { general: "unmanaged" }, reason: "Audit failure rehearsal" }, actor)).rejects.toThrow("synthetic audit failure"); }
    finally { await pool.query("DROP TRIGGER reject_bulk_test_audit ON audit_logs"); await pool.query("DROP FUNCTION reject_bulk_test_audit()"); }
    expect(unwrap(await previewBulkResponsibility(pool, scope, [first, second])).map((row) => ({ id: row.id, general: row.general }))).toEqual(targets.map((row) => ({ id: row.id, general: row.general })));
  });
  it("saves one employee field with a frozen value without invalidating its sibling draft", async () => {
    expect(await saveOperationalResponsibility(testPool(), "employee", employee, { field: "scheduling", expectedValue: "undecided", value: "managed" }, actor)).toMatchObject({ ok: true });
    expect(await saveOperationalResponsibility(testPool(), "employee", employee, { field: "money", expectedValue: "undecided", value: "unmanaged" }, actor)).toMatchObject({ ok: true });
    expect(await saveOperationalResponsibility(testPool(), "employee", employee, { field: "scheduling", expectedValue: "undecided", value: "unmanaged" }, actor)).toMatchObject({ ok: false, code: "conflict" });
    expect((await testPool().query("SELECT scheduling_responsibility, money_responsibility FROM employees WHERE id=$1", [employee])).rows[0]).toEqual({ scheduling_responsibility: "managed", money_responsibility: "unmanaged" });
  });
});

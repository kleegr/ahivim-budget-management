import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool, countRows,
} from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import type { Result, ResultCode } from "@/lib/manage/errors";
import {
  createIndividual, updateIndividual, setIndividualStatus, listIndividualsManaged,
} from "@/lib/manage/individuals";
import { createEmployee, updateEmployee, setEmployeeStatus } from "@/lib/manage/employees";
import { createAssignment, setAssignmentStatus, updateAssignment } from "@/lib/manage/assignments";
import {
  createBudgetPeriod, createAuthorization, reviseAuthorization, cancelAuthorization,
} from "@/lib/manage/authorizations";
import { createAlias, setAliasStatus, rematchAlias, suggestMatches, listAliases } from "@/lib/manage/aliases";
import { createProgram, addProgramRate } from "@/lib/manage/programs";

/**
 * Editable-operations service layer, exercised against a real PostgreSQL.
 *
 * Every mutation funnels through recordChange, so the tests assert not just the
 * returned Result but the durable side effects: the row that changed AND the
 * audit_logs entry (action, metadata, reason, actor) that must accompany it.
 */

const suite = hasTestDatabase ? describe : describe.skip;

// audit_logs.user_id is a FK to users. A real actor row is inserted in
// beforeEach (truncateBusinessTables clears users) so every audit row it writes
// carries a valid actor.
const ACTOR = "00000000-0000-4000-8000-000000000001";

let pool: PgLikePool;

/** Assert a Result succeeded and return its data, with a useful message on failure. */
function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok but got ${r.code}: ${r.message}`);
  return r.data;
}

/** Assert a Result failed with a specific code. */
function expectFail(r: Result<unknown>, code: ResultCode): void {
  if (r.ok) throw new Error(`expected failure "${code}" but got ok`);
  expect(r.code).toBe(code);
}

interface AuditRow {
  action: string;
  reason: string | null;
  metadata: unknown;
  user_id: string | null;
}

/** The most recently written audit row (ctid breaks any created_at tie). */
async function latestAudit(): Promise<AuditRow> {
  const { rows } = await testPool().query<AuditRow>(
    `SELECT action, reason, metadata, user_id
       FROM audit_logs ORDER BY created_at DESC, ctid DESC LIMIT 1`,
  );
  return rows[0];
}

async function scalar<T>(sql: string, params: unknown[]): Promise<T | undefined> {
  const { rows } = await testPool().query<Record<string, T>>(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

/** A seeded, never-truncated program to hang assignments and authorizations on. */
async function seedProgramId(): Promise<string> {
  const id = await scalar<string>(`SELECT id FROM programs WHERE code = 'COM_HAB'`, []);
  if (!id) throw new Error("seeded program COM_HAB missing");
  return id;
}

// Programs are reference data and are NOT truncated between tests, so each
// created program needs a code unique across the whole file.
let progSeq = 0;
function nextProgram(): { input: string; expected: string } {
  progSeq += 1;
  // Lowercased with spaces so the assertion proves both uppercasing and the
  // non-alphanumeric -> underscore rule.
  return { input: `zz svc ${progSeq}`, expected: `ZZ_SVC_${progSeq}` };
}

suite("editable operations service layer (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin')`,
      [ACTOR, "admin@ahivim.test", "Admin Actor", "x"],
    );
  });

  afterAll(closeTestPool);

  /* ---------------------------------------------------------------- individuals */
  describe("individuals", () => {
    it("creates an active individual and rejects a duplicate name as a conflict", async () => {
      const a = expectOk(await createIndividual(pool, { displayName: "Aaron Klein" }, ACTOR));
      expect(a.status).toBe("active");
      expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
      expectFail(await createIndividual(pool, { displayName: "Aaron Klein" }, ACTOR), "conflict");
    });

    it("updates fields and treats a rename onto an existing name as a conflict", async () => {
      const a = expectOk(await createIndividual(pool, { displayName: "Aaron Klein" }, ACTOR));
      const b = expectOk(await createIndividual(pool, { displayName: "Boruch Stern" }, ACTOR));

      const upd = expectOk(
        await updateIndividual(
          pool,
          a.id,
          { displayName: "Aaron Klein", preferredName: "Ari", notes: "VIP" },
          ACTOR,
        ),
      );
      expect(upd.preferredName).toBe("Ari");
      expect(upd.notes).toBe("VIP");

      // Renaming Aaron onto Boruch's name collides.
      expectFail(
        await updateIndividual(pool, a.id, { displayName: "Boruch Stern" }, ACTOR),
        "conflict",
      );
      expect(b.id).not.toBe(a.id);
    });

    it("archives (sets archived_at) and restores (clears it), verified by direct SQL", async () => {
      const a = expectOk(await createIndividual(pool, { displayName: "Chana Weiss" }, ACTOR));

      const archived = expectOk(await setIndividualStatus(pool, a.id, "archived", ACTOR));
      expect(archived.status).toBe("archived");
      let row = (
        await pool.query<{ status: string; archived_at: string | null }>(
          `SELECT status, archived_at FROM individuals WHERE id = $1`,
          [a.id],
        )
      ).rows[0];
      expect(row.status).toBe("archived");
      expect(row.archived_at).not.toBeNull();

      const restored = expectOk(await setIndividualStatus(pool, a.id, "active", ACTOR));
      expect(restored.status).toBe("active");
      row = (
        await pool.query<{ status: string; archived_at: string | null }>(
          `SELECT status, archived_at FROM individuals WHERE id = $1`,
          [a.id],
        )
      ).rows[0];
      expect(row.status).toBe("active");
      expect(row.archived_at).toBeNull();
    });

    it("excludes archived from the list unless asked, and filters by name search", async () => {
      const dovid = expectOk(await createIndividual(pool, { displayName: "Dovid Green" }, ACTOR));
      const esther = expectOk(await createIndividual(pool, { displayName: "Esther Gold" }, ACTOR));
      expectOk(await setIndividualStatus(pool, esther.id, "archived", ACTOR));

      const active = await listIndividualsManaged(pool, {});
      const activeIds = active.map((i) => i.id);
      expect(activeIds).toContain(dovid.id);
      expect(activeIds).not.toContain(esther.id);

      const all = await listIndividualsManaged(pool, { includeArchived: true });
      expect(all.map((i) => i.id)).toContain(esther.id);

      const found = await listIndividualsManaged(pool, { search: "Dovid" });
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(dovid.id);
    });

    it("writes exactly one audit row per successful mutation, with action and metadata", async () => {
      let count = await countRows("audit_logs");
      const a = expectOk(await createIndividual(pool, { displayName: "Faiga Roth" }, ACTOR));
      expect(await countRows("audit_logs")).toBe(count + 1);
      let latest = await latestAudit();
      expect(latest.action).toBe("individual_created");
      expect(latest.metadata).not.toBeNull();

      count = await countRows("audit_logs");
      expectOk(await updateIndividual(pool, a.id, { displayName: "Faiga Roth", notes: "x" }, ACTOR));
      expect(await countRows("audit_logs")).toBe(count + 1);
      latest = await latestAudit();
      expect(latest.action).toBe("individual_updated");
      expect(latest.metadata).not.toBeNull();

      count = await countRows("audit_logs");
      expectOk(await setIndividualStatus(pool, a.id, "archived", ACTOR));
      expect(await countRows("audit_logs")).toBe(count + 1);
      latest = await latestAudit();
      expect(latest.action).toBe("individual_archived");
      expect(latest.metadata).not.toBeNull();
    });

    it("stores the supplied reason and actor on the audit row", async () => {
      expectOk(await createIndividual(pool, { displayName: "Gitty Blum" }, ACTOR, "intake paperwork"));
      const latest = await latestAudit();
      expect(latest.action).toBe("individual_created");
      expect(latest.reason).toBe("intake paperwork");
      expect(latest.user_id).toBe(ACTOR);
    });
  });

  /* ----------------------------------------------------------------- employees */
  describe("employees", () => {
    it("creates, rejects a duplicate, updates, archives and restores", async () => {
      const e = expectOk(await createEmployee(pool, { displayName: "Miriam Katz" }, ACTOR));
      expect(e.status).toBe("active");
      expectFail(await createEmployee(pool, { displayName: "Miriam Katz" }, ACTOR), "conflict");

      const upd = expectOk(
        await updateEmployee(pool, e.id, { displayName: "Miriam Katz", notes: "lead aide" }, ACTOR),
      );
      expect(upd.notes).toBe("lead aide");

      const archived = expectOk(await setEmployeeStatus(pool, e.id, "archived", ACTOR));
      expect(archived.status).toBe("archived");
      expect(archived.archivedAt).not.toBeNull();

      const restored = expectOk(await setEmployeeStatus(pool, e.id, "active", ACTOR));
      expect(restored.status).toBe("active");
      expect(restored.archivedAt).toBeNull();
    });

    it("writes an audit row when an employee is created", async () => {
      const before = await countRows("audit_logs");
      expectOk(await createEmployee(pool, { displayName: "Yosef Adler" }, ACTOR));
      expect(await countRows("audit_logs")).toBe(before + 1);
      const latest = await latestAudit();
      expect(latest.action).toBe("employee_created");
      expect(latest.metadata).not.toBeNull();
    });
  });

  /* --------------------------------------------------------------- assignments */
  describe("assignments", () => {
    async function pair() {
      const employee = expectOk(await createEmployee(pool, { displayName: "Rivka Stern" }, ACTOR));
      const individual = expectOk(await createIndividual(pool, { displayName: "Shimon Katz" }, ACTOR));
      const programId = await seedProgramId();
      return { employeeId: employee.id, individualId: individual.id, programId };
    }

    it("creates an assignment and rejects a duplicate active triple", async () => {
      const { employeeId, individualId, programId } = await pair();
      const a = expectOk(await createAssignment(pool, { employeeId, individualId, programId }, ACTOR));
      expect(a.status).toBe("active");
      expectFail(
        await createAssignment(pool, { employeeId, individualId, programId }, ACTOR),
        "conflict",
      );
    });

    it("serializes concurrent overlapping assignment creates", async () => {
      const { employeeId, individualId, programId } = await pair();
      const blocker = await testPool().connect();
      let committed = false;
      let attempts!: Promise<Array<Awaited<ReturnType<typeof createAssignment>>>>;
      try {
        await blocker.query("BEGIN");
        await blocker.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `assignment:${employeeId}:${individualId}:${programId}`,
        ]);
        attempts = Promise.all([
          createAssignment(pool, {
            employeeId,
            individualId,
            programId,
            startDate: "2025-01-01",
            endDate: "2025-06-30",
          }, ACTOR),
          createAssignment(pool, {
            employeeId,
            individualId,
            programId,
            startDate: "2025-06-15",
            endDate: "2025-12-31",
          }, ACTOR),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await blocker.query("COMMIT");
        committed = true;
      } finally {
        if (!committed) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }

      const results = await attempts;
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.code === "conflict")).toHaveLength(1);
      expect(await scalar<number>(
        `SELECT count(*)::int FROM assignments
          WHERE employee_id = $1 AND individual_id = $2 AND program_id = $3`,
        [employeeId, individualId, programId],
      )).toBe(1);
      expect(await scalar<number>(
        `SELECT count(*)::int FROM audit_logs
          WHERE action = 'assignment_created'
            AND metadata->'next'->>'employeeId' = $1
            AND metadata->'next'->>'individualId' = $2`,
        [employeeId, individualId],
      )).toBe(1);
    }, 15_000);

    it("permits re-creating the same triple once the prior assignment is ended", async () => {
      const { employeeId, individualId, programId } = await pair();
      const first = expectOk(await createAssignment(pool, { employeeId, individualId, programId }, ACTOR));

      const ended = expectOk(await setAssignmentStatus(pool, first.id, "ended", ACTOR));
      expect(ended.status).toBe("ended");

      const second = expectOk(await createAssignment(pool, { employeeId, individualId, programId }, ACTOR));
      expect(second.status).toBe("active");
      expect(second.id).not.toBe(first.id);
    });

    it("blocks restoring an ended assignment when its replacement overlaps", async () => {
      const { employeeId, individualId, programId } = await pair();
      const first = expectOk(await createAssignment(pool, {
        employeeId,
        individualId,
        programId,
        startDate: "2025-01-01",
        endDate: "2025-12-31",
      }, ACTOR));
      expectOk(await setAssignmentStatus(pool, first.id, "ended", ACTOR));
      expectOk(await createAssignment(pool, {
        employeeId,
        individualId,
        programId,
        startDate: "2025-07-01",
        endDate: "2026-06-30",
      }, ACTOR));

      expectFail(await setAssignmentStatus(pool, first.id, "active", ACTOR), "conflict");
    });

    it("supports date-disjoint assignment periods and blocks overlapping edits", async () => {
      const { employeeId, individualId, programId } = await pair();
      const first = expectOk(await createAssignment(pool, {
        employeeId,
        individualId,
        programId,
        startDate: "2025-01-01",
        endDate: "2025-06-30",
      }, ACTOR));
      const second = expectOk(await createAssignment(pool, {
        employeeId,
        individualId,
        programId,
        startDate: "2025-07-01",
        endDate: "2025-12-31",
      }, ACTOR));
      expect(first.id).not.toBe(second.id);

      expectFail(await updateAssignment(pool, second.id, {
        startDate: "2025-06-15",
      }, ACTOR), "conflict");
    });

    it("rolls back an assignment mutation when its audit write fails", async () => {
      const { employeeId, individualId, programId } = await pair();
      const assignment = expectOk(await createAssignment(pool, {
        employeeId,
        individualId,
        programId,
        notes: "Original note",
      }, ACTOR));

      await expect(updateAssignment(
        pool,
        assignment.id,
        { notes: "Must roll back" },
        "00000000-0000-4000-8000-000000000099",
      )).rejects.toThrow();

      expect(await scalar<string>(`SELECT notes FROM assignments WHERE id = $1`, [assignment.id]))
        .toBe("Original note");
      expect(await scalar<number>(
        `SELECT count(*)::int FROM audit_logs
          WHERE action = 'assignment_updated' AND entity_id = $1`,
        [assignment.id],
      )).toBe(0);
    });

    it("normalizes allowed hours and rejects negative capacity", async () => {
      const { employeeId, individualId, programId } = await pair();
      const assignment = expectOk(await createAssignment(pool, {
        employeeId,
        individualId,
        programId,
        allowedHours: "12.5",
      }, ACTOR));
      expect(assignment.allowedHours).toBe("12.5000");

      expectFail(await createAssignment(pool, {
        employeeId,
        individualId,
        allowedHours: "-1",
      }, ACTOR), "validation");
    });

    it("rejects an end date that precedes the start date", async () => {
      const { employeeId, individualId } = await pair();
      expectFail(
        await createAssignment(
          pool,
          { employeeId, individualId, startDate: "2025-05-10", endDate: "2025-05-01" },
          ACTOR,
        ),
        "validation",
      );
    });
  });

  /* ------------------------------------------------------------ authorizations */
  describe("authorizations", () => {
    async function setup() {
      const individual = expectOk(await createIndividual(pool, { displayName: "Tova Berger" }, ACTOR));
      const period = expectOk(
        await createBudgetPeriod(
          pool,
          { individualId: individual.id, label: "FY25", startDate: "2025-01-01", endDate: "2025-12-31" },
          ACTOR,
        ),
      );
      const programId = await seedProgramId();
      return { individualId: individual.id, periodId: period.id, programId };
    }

    it("creates revision 1 (active) and rejects a second active one for the same period+program", async () => {
      const { periodId, programId } = await setup();
      const auth = expectOk(
        await createAuthorization(
          pool,
          { budgetPeriodId: periodId, programId, authorizedHours: "100", internalRate: "21" },
          ACTOR,
        ),
      );
      expect(auth.revision).toBe(1);
      expect(auth.status).toBe("active");

      expectFail(
        await createAuthorization(
          pool,
          { budgetPeriodId: periodId, programId, authorizedHours: "50", internalRate: "21" },
          ACTOR,
        ),
        "conflict",
      );
    });

    it("revises by superseding: old superseded, new revision 2 active, exactly one active", async () => {
      const { periodId, programId } = await setup();
      const auth = expectOk(
        await createAuthorization(
          pool,
          { budgetPeriodId: periodId, programId, authorizedHours: "100", internalRate: "21" },
          ACTOR,
        ),
      );

      const revised = expectOk(await reviseAuthorization(pool, auth.id, { authorizedHours: "120" }, ACTOR));
      expect(revised.revision).toBe(2);
      expect(revised.status).toBe("active");
      expect(revised.supersedesId).toBe(auth.id);
      expect(Number(revised.authorizedHours)).toBe(120);
      expect(revised.id).not.toBe(auth.id);

      const oldStatus = await scalar<string>(
        `SELECT status FROM budget_authorizations WHERE id = $1`,
        [auth.id],
      );
      expect(oldStatus).toBe("superseded");

      const activeCount = await scalar<number>(
        `SELECT count(*)::int AS c FROM budget_authorizations
          WHERE budget_period_id = $1 AND program_id = $2 AND status = 'active'`,
        [periodId, programId],
      );
      expect(activeCount).toBe(1);

      const revisedAudits = await scalar<number>(
        `SELECT count(*)::int AS c FROM audit_logs WHERE action = 'authorization_revised'`,
        [],
      );
      expect(revisedAudits).toBe(1);
    });

    it("cancels an authorization", async () => {
      const { periodId, programId } = await setup();
      const auth = expectOk(
        await createAuthorization(
          pool,
          { budgetPeriodId: periodId, programId, authorizedHours: "80", internalRate: "21" },
          ACTOR,
        ),
      );
      const cancelled = expectOk(await cancelAuthorization(pool, auth.id, ACTOR));
      expect(cancelled.status).toBe("cancelled");
    });

    it("refuses to revise a non-active authorization (immutable)", async () => {
      const { periodId, programId } = await setup();
      const auth = expectOk(
        await createAuthorization(
          pool,
          { budgetPeriodId: periodId, programId, authorizedHours: "80", internalRate: "21" },
          ACTOR,
        ),
      );
      expectOk(await cancelAuthorization(pool, auth.id, ACTOR));
      expectFail(await reviseAuthorization(pool, auth.id, { authorizedHours: "5" }, ACTOR), "immutable");
    });
  });

  /* -------------------------------------------------------------------- aliases */
  describe("aliases", () => {
    async function aliasRow(id: string) {
      return (
        await pool.query<{ status: string; approved_at: string | null; archived_at: string | null; approved_by_user_id: string | null }>(
          `SELECT status, approved_at::text AS approved_at, archived_at::text AS archived_at, approved_by_user_id FROM individual_aliases WHERE id = $1`,
          [id],
        )
      ).rows[0];
    }

    it("creates a pending alias and approves it (status approved, approved_at set)", async () => {
      const person = expectOk(await createIndividual(pool, { displayName: "Yaakov Cohen" }, ACTOR));
      const created = expectOk(
        await createAlias(pool, "individual", { importedName: "Y. Cohen", canonicalId: person.id }, ACTOR),
      );

      let row = await aliasRow(created.id);
      expect(row.status).toBe("pending");
      expect(row.approved_at).toBeNull();

      expectOk(await setAliasStatus(pool, "individual", created.id, "approved", ACTOR));
      row = await aliasRow(created.id);
      expect(row.status).toBe("approved");
      expect(row.approved_at).not.toBeNull();
    });

    it("rejects and archives an alias without an actor-parameter mismatch", async () => {
      const person = expectOk(await createIndividual(pool, { displayName: "Nochum Reich" }, ACTOR));
      const created = expectOk(
        await createAlias(pool, "individual", { importedName: "N. Reich", canonicalId: person.id }, ACTOR),
      );

      // Reject: status flips, approver is cleared, no bind-count error.
      expectOk(await setAliasStatus(pool, "individual", created.id, "rejected", ACTOR));
      expect((await aliasRow(created.id)).status).toBe("rejected");

      // Archive: sets archived_at; still no bind error on the non-approved path.
      expectOk(await setAliasStatus(pool, "individual", created.id, "archived", ACTOR));
      const archived = await aliasRow(created.id);
      expect(archived.status).toBe("archived");
      expect(archived.archived_at).not.toBeNull();

      // Re-approve restores the approver stamp.
      expectOk(await setAliasStatus(pool, "individual", created.id, "approved", ACTOR));
      const approved = await aliasRow(created.id);
      expect(approved.status).toBe("approved");
      expect(approved.approved_by_user_id).toBe(ACTOR);
    });

    it("rematches an alias onto a different canonical individual", async () => {
      const first = expectOk(await createIndividual(pool, { displayName: "Leah First" }, ACTOR));
      const second = expectOk(await createIndividual(pool, { displayName: "Leah Second" }, ACTOR));
      const created = expectOk(
        await createAlias(pool, "individual", { importedName: "L. Ambiguous", canonicalId: first.id }, ACTOR),
      );

      expectOk(await rematchAlias(pool, "individual", created.id, second.id, ACTOR));
      const canonical = await scalar<string>(
        `SELECT individual_id FROM individual_aliases WHERE id = $1`,
        [created.id],
      );
      expect(canonical).toBe(second.id);
      expect(canonical).not.toBe(first.id);
    });

    it("lists aliases with management metadata (imported name, canonical, dates)", async () => {
      const person = expectOk(await createIndividual(pool, { displayName: "Tzvi Berg" }, ACTOR));
      expectOk(await createAlias(pool, "individual", { importedName: "T. Berg", canonicalId: person.id, approve: true }, ACTOR));
      const rows = await listAliases(pool, { kind: "individual" });
      const row = rows.find((r) => r.importedName === "T. Berg");
      expect(row).toBeDefined();
      expect(row!.canonicalName).toBe("Tzvi Berg");
      expect(row!.status).toBe("approved");
      expect(row!.rowsAffected).toBe(0);
      // filtering by status and search must not throw and must narrow.
      expect((await listAliases(pool, { status: "approved", search: "Berg" })).length).toBeGreaterThan(0);
    });

    it("rejects a second alias whose spelling normalizes to an existing one", async () => {
      const person = expectOk(await createIndividual(pool, { displayName: "Menachem Gold" }, ACTOR));
      expectOk(
        await createAlias(pool, "individual", { importedName: "Yaakov Cohen", canonicalId: person.id }, ACTOR),
      );
      // "Cohen, Yaakov" normalizes to the same key as "Yaakov Cohen".
      expectFail(
        await createAlias(pool, "individual", { importedName: "Cohen, Yaakov", canonicalId: person.id }, ACTOR),
        "conflict",
      );
    });

    it("suggests a near miss but flags an exact existing name as exact", async () => {
      expectOk(await createIndividual(pool, { displayName: "Isaac Neuwirth" }, ACTOR));

      const near = await suggestMatches(pool, "individual", "Issac Neuwirth");
      expect(near.exact).toBe(false);
      expect(near.suggestions.length).toBeGreaterThan(0);
      expect(near.suggestions[0].displayName).toContain("Isaac");

      const exact = await suggestMatches(pool, "individual", "Isaac Neuwirth");
      expect(exact.exact).toBe(true);
    });
  });

  /* ------------------------------------------------------------------- programs */
  describe("programs", () => {
    it("creates a program with an uppercased code and rejects a duplicate code", async () => {
      const { input, expected } = nextProgram();
      const program = expectOk(await createProgram(pool, { code: input, name: "Alpha Service" }, ACTOR));
      expect(program.code).toBe(expected);
      expectFail(await createProgram(pool, { code: input, name: "Alpha Again" }, ACTOR), "conflict");
    });

    it("adds an effective-dated rate and writes an audit row", async () => {
      const { input } = nextProgram();
      const program = expectOk(await createProgram(pool, { code: input, name: "Beta Service" }, ACTOR));

      const before = await countRows("audit_logs");
      const rate = expectOk(
        await addProgramRate(
          pool,
          program.id,
          { effectiveFrom: "2025-01-01", internalRate: "20", agencyRate: "22" },
          ACTOR,
        ),
      );
      expect(rate.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(await countRows("audit_logs")).toBe(before + 1);
      expect((await latestAudit()).action).toBe("program_rate_added");

      const row = (
        await pool.query<{ internal_rate: string; effective_from: string }>(
          `SELECT internal_rate::text AS internal_rate, effective_from::text AS effective_from
             FROM program_rate_schedules WHERE id = $1`,
          [rate.id],
        )
      ).rows[0];
      expect(Number(row.internal_rate)).toBe(20);
      expect(row.effective_from).toBe("2025-01-01");
      expectFail(
        await addProgramRate(
          pool,
          program.id,
          { effectiveFrom: "2025-01-01", internalRate: "21", agencyRate: "23" },
          ACTOR,
        ),
        "conflict",
      );
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateMonthlyClassDates } from "@/lib/business/class-invoicing";
import { getClassBudget } from "@/lib/data/class-invoices";
import {
  getClassCoverSheetSnapshot,
  getClassReimbursementProfile,
} from "@/lib/data/class-reimbursement-profiles";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import {
  createClassActivity,
  createClassBudget,
  createClassInvoiceDraft,
  discardClassInvoiceDraft,
  issueClassInvoice,
  updateClassActivity,
  updateClassBudget,
  updateClassInvoiceDraft,
  voidClassInvoice,
} from "@/lib/manage/class-invoices";
import {
  createClassCoverSheetSnapshot,
  saveClassReimbursementProfile,
} from "@/lib/manage/class-reimbursement-profiles";
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

suite("class invoice ledger (real PostgreSQL)", () => {
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
    await pool.query(
      `INSERT INTO class_activities (code, name, default_unit_price, sort_order)
       VALUES ('EXERCISE', 'Exercise Class', 150, 10),
              ('ART', 'Art Class', 150, 20),
              ('MUSIC', 'Music Class', 150, 30)`,
    );
  });

  afterAll(closeTestPool);

  async function activityIds(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM class_activities WHERE code IN ('EXERCISE', 'ART', 'MUSIC') ORDER BY sort_order`,
    );
    return rows.map((row) => row.id);
  }

  async function rejectingClassActivityAudits(run: () => Promise<void>): Promise<void> {
    await pool.query(
      `ALTER TABLE audit_logs
         ADD CONSTRAINT test_reject_class_activity_audit
         CHECK (action NOT IN ('class_activity_created', 'class_activity_updated'))`,
    );
    try {
      await run();
    } finally {
      await pool.query(
        `ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS test_reject_class_activity_audit`,
      );
    }
  }

  function signaledProfilePool(onReadOrLock: () => void): PgLikePool {
    return {
      query: <T>(sql: string, params?: unknown[]) => pool.query<T>(sql, params),
      connect: async (): Promise<PgLikeClient> => {
        const client = await pool.connect();
        return {
          query: async <T>(sql: string, params?: unknown[]) => {
            const normalized = sql.replace(/\s+/g, " ").trim();
            const isIndividualLock = normalized.includes(
              "SELECT id FROM individuals WHERE id = $1 FOR UPDATE",
            );
            if (isIndividualLock) onReadOrLock();
            const result = await client.query<T>(sql, params);
            if (
              !isIndividualLock
              && normalized.includes("FROM individuals individual")
              && normalized.includes("LEFT JOIN class_reimbursement_profiles")
            ) {
              onReadOrLock();
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    };
  }

  it("rolls back a new class activity when its audit entry fails", async () => {
    await rejectingClassActivityAudits(async () => {
      await expect(createClassActivity(pool, {
        code: "COOKING",
        name: "Cooking Class",
        defaultUnitPrice: "150",
      }, ACTOR)).rejects.toThrow();
    });

    const activity = await pool.query(`SELECT 1 FROM class_activities WHERE code = 'COOKING'`);
    const audit = await pool.query(
      `SELECT 1 FROM audit_logs WHERE action = 'class_activity_created'`,
    );
    expect(activity.rows).toHaveLength(0);
    expect(audit.rows).toHaveLength(0);
  });

  it("rolls back a class activity update when its audit entry fails", async () => {
    const [activityId] = await activityIds();
    await rejectingClassActivityAudits(async () => {
      await expect(updateClassActivity(pool, activityId, {
        code: "EXERCISE",
        name: "Changed Exercise Class",
        defaultUnitPrice: "175",
      }, ACTOR)).rejects.toThrow();
    });

    const activity = await pool.query<{ name: string; default_unit_price: string }>(
      `SELECT name, default_unit_price::text AS default_unit_price
         FROM class_activities WHERE id = $1`,
      [activityId],
    );
    const audit = await pool.query(
      `SELECT 1 FROM audit_logs WHERE action = 'class_activity_updated'`,
    );
    expect(activity.rows[0]).toEqual({
      name: "Exercise Class",
      default_unit_price: "150.0000",
    });
    expect(audit.rows).toHaveLength(0);
  });

  it("issues the supplied 22-day pattern once, freezes it, and releases consumption on void", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Class Client One" }, ACTOR));
    const budget = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      label: "2026 classes",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "20000",
    }, ACTOR));
    const activities = await activityIds();
    const dates = generateMonthlyClassDates("2026-07");
    const draft = unwrap(await createClassInvoiceDraft(pool, {
      classBudgetPeriodId: budget.id,
      invoiceNumber: "8513",
      invoiceDate: "2026-08-02",
      servicePeriodStart: "2026-07-01",
      servicePeriodEnd: "2026-07-31",
      purpose: "CLASSES",
      lines: dates.map((serviceDate, index) => ({
        activityId: activities[index % activities.length],
        serviceDate,
      })),
    }, ACTOR));

    expect(draft.status).toBe("draft");
    expect(draft.lines).toHaveLength(22);
    expect(draft.totalAmount).toBe("3300.0000");

    const manual = await pool.connect();
    try {
      await manual.query("BEGIN");
      await manual.query(
        `UPDATE class_invoices
            SET status = 'issued', issued_by_user_id = $1, issued_at = now(),
                budget_authorized_snapshot = 20000,
                budget_consumed_before_snapshot = 0,
                budget_overage_snapshot = 0
          WHERE id = $2`,
        [ACTOR, draft.id],
      );
      await expect(manual.query("COMMIT")).rejects.toThrow(/append-only budget ledger/i);
      await manual.query("ROLLBACK").catch(() => undefined);
    } finally {
      manual.release();
    }

    const issued = unwrap(await issueClassInvoice(pool, draft.id, ACTOR));
    expect(issued).toMatchObject({
      status: "issued",
      subtotal: "3300.0000",
      totalAmount: "3300.0000",
      budgetAuthorizedSnapshot: "20000.0000",
      budgetConsumedBeforeSnapshot: "0.0000",
      budgetOverageSnapshot: "0.0000",
    });
    expect(await getClassBudget(pool, budget.id)).toMatchObject({
      consumedAmount: "3300.0000",
      remainingAmount: "16700.0000",
    });

    await expect(updateClassInvoiceDraft(pool, draft.id, { notes: "too late" }, ACTOR))
      .resolves.toMatchObject({ ok: false, code: "immutable" });
    await expect(pool.query(
      `UPDATE class_invoice_lines SET unit_price = 1 WHERE class_invoice_id = $1`,
      [draft.id],
    )).rejects.toThrow(/editable only while.*draft/i);
    await expect(pool.query(
      `UPDATE class_invoices
          SET subtotal = 1, discount_total = 0, total_amount = 1
        WHERE id = $1`,
      [draft.id],
    )).rejects.toThrow(/immutable/i);

    const voided = unwrap(await voidClassInvoice(pool, draft.id, ACTOR, "Duplicate submission"));
    expect(voided).toMatchObject({ status: "void", totalAmount: "3300.0000" });
    expect(await getClassBudget(pool, budget.id)).toMatchObject({
      consumedAmount: "0.0000",
      remainingAmount: "20000.0000",
    });
    const ledger = await pool.query<{ event_type: string; amount: string }>(
      `SELECT event_type, amount::text AS amount
         FROM class_budget_ledger WHERE class_invoice_id = $1 ORDER BY created_at, event_type`,
      [draft.id],
    );
    expect(ledger.rows).toEqual(expect.arrayContaining([
      { event_type: "issue", amount: "3300.0000" },
      { event_type: "void", amount: "-3300.0000" },
    ]));
    await expect(pool.query(
      `UPDATE class_budget_ledger SET amount = 1 WHERE class_invoice_id = $1`,
      [draft.id],
    )).rejects.toThrow(/append-only/i);
  });

  it("blocks an annual overage until a written override and protects budget changes", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Class Client Two" }, ACTOR));
    const budget = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      label: "Renewal year",
      startDate: "2026-03-01",
      endDate: "2027-02-28",
      authorizedAmount: "200",
    }, ACTOR));
    const [activityId] = await activityIds();
    const draft = unwrap(await createClassInvoiceDraft(pool, {
      classBudgetPeriodId: budget.id,
      invoiceNumber: "OVER-1",
      invoiceDate: "2026-08-02",
      servicePeriodStart: "2026-07-01",
      servicePeriodEnd: "2026-07-31",
      lines: ["2026-07-01", "2026-07-02"].map((serviceDate) => ({ activityId, serviceDate })),
    }, ACTOR));

    const blocked = await issueClassInvoice(pool, draft.id, ACTOR);
    expect(blocked).toMatchObject({
      ok: false,
      code: "conflict",
      details: {
        kind: "class_budget_overage",
        authorizedAmount: "200.0000",
        consumedAmount: "0.0000",
        invoiceAmount: "300.0000",
        projectedAmount: "300.0000",
        overageAmount: "100.0000",
      },
    });
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM class_invoices WHERE id = $1`,
      [draft.id],
    )).rows[0]?.status).toBe("draft");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM class_budget_ledger WHERE class_invoice_id = $1`,
      [draft.id],
    )).rows[0]?.count).toBe("0");

    const issued = unwrap(await issueClassInvoice(pool, draft.id, ACTOR, {
      overBudgetOverrideReason: "Approved by director for this renewal year",
    }));
    expect(issued).toMatchObject({
      status: "issued",
      totalAmount: "300.0000",
      budgetOverageSnapshot: "100.0000",
      overBudgetOverrideReason: "Approved by director for this renewal year",
    });

    await expect(updateClassBudget(pool, budget.id, { authorizedAmount: "100" }, ACTOR))
      .resolves.toMatchObject({ ok: false, code: "conflict" });
    const reduced = unwrap(await updateClassBudget(pool, budget.id, {
      authorizedAmount: "100",
      overBudgetOverrideReason: "Director approved lower recorded allowance",
    }, ACTOR));
    expect(reduced).toMatchObject({
      authorizedAmount: "100.0000",
      consumedAmount: "300.0000",
      remainingAmount: "-200.0000",
    });
  });

  it("prevents reopening a closed annual budget over a replacement period", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Renewal Person" }, ACTOR));
    const original = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "10000",
    }, ACTOR));
    unwrap(await updateClassBudget(pool, original.id, { status: "closed" }, ACTOR));
    unwrap(await createClassBudget(pool, {
      individualId: person.id,
      startDate: "2026-07-01",
      endDate: "2027-06-30",
      authorizedAmount: "10000",
    }, ACTOR));

    await expect(updateClassBudget(pool, original.id, { status: "active" }, ACTOR))
      .resolves.toMatchObject({ ok: false, code: "conflict" });
  });

  it("does not close an allowance while it still has editable invoice drafts", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Open Draft Person" }, ACTOR));
    const budget = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "10000",
    }, ACTOR));
    const [activityId] = await activityIds();
    const draft = unwrap(await createClassInvoiceDraft(pool, {
      classBudgetPeriodId: budget.id,
      invoiceNumber: "OPEN-DRAFT",
      invoiceDate: "2026-08-02",
      servicePeriodStart: "2026-07-01",
      servicePeriodEnd: "2026-07-31",
      lines: [{ activityId, serviceDate: "2026-07-01" }],
    }, ACTOR));

    await expect(updateClassBudget(pool, budget.id, { status: "closed" }, ACTOR))
      .resolves.toMatchObject({ ok: false, code: "conflict" });
    expect(await getClassBudget(pool, budget.id)).toMatchObject({ status: "active" });

    expect(unwrap(await discardClassInvoiceDraft(pool, draft.id, ACTOR))).toEqual({ id: draft.id });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM class_invoices WHERE id = $1`,
      [draft.id],
    )).rows[0]?.count).toBe("0");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_logs
        WHERE action = 'class_invoice_draft_discarded' AND entity_id = $1`,
      [draft.id],
    )).rows[0]?.count).toBe("1");
    expect(unwrap(await updateClassBudget(pool, budget.id, { status: "closed" }, ACTOR)))
      .toMatchObject({ status: "closed" });
  });

  it("serializes simultaneous issues so stale budget consumption cannot slip through", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Concurrent Person" }, ACTOR));
    const budget = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "450",
    }, ACTOR));
    const [activityId] = await activityIds();
    const makeDraft = (invoiceNumber: string, offset: number) => createClassInvoiceDraft(pool, {
      classBudgetPeriodId: budget.id,
      invoiceNumber,
      invoiceDate: "2026-08-02",
      servicePeriodStart: "2026-07-01",
      servicePeriodEnd: "2026-07-31",
      lines: [1, 2].map((day) => ({
        activityId,
        serviceDate: `2026-07-${String(day + offset).padStart(2, "0")}`,
      })),
    }, ACTOR);
    const first = unwrap(await makeDraft("RACE-1", 0));
    const second = unwrap(await makeDraft("RACE-2", 4));

    const results = await Promise.all([
      issueClassInvoice(pool, first.id, ACTOR),
      issueClassInvoice(pool, second.id, ACTOR),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        ok: false,
        code: "conflict",
        details: expect.objectContaining({ overageAmount: "150.0000" }),
      }),
    ]);
    expect(await getClassBudget(pool, budget.id)).toMatchObject({
      consumedAmount: "300.0000",
      remainingAmount: "150.0000",
    });
  });

  it("reuses reimbursement details without copying sensitive values into audit metadata", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Cover Profile" }, ACTOR));
    const saved = unwrap(await saveClassReimbursementProfile(pool, person.id, {
      mailingName: "Cover Profile",
      addressLine1: "100 Main Street",
      cityStateZip: "Monroe NY 10950",
      phone: "845-555-0100",
      dateOfBirth: "2000-01-01",
      medicaidId: "SENSITIVE-SAMPLE-ID",
      fiscalIntermediary: "Ahivim",
      payableTo: "Xcellent Staffing",
      budgetCategory: "Community classes",
      lifePlanConfirmed: true,
      formCompletedBy: "Authorized Representative",
      relationship: "Representative",
    }, ACTOR));

    expect(saved).toMatchObject({
      individualId: person.id,
      medicaidId: "SENSITIVE-SAMPLE-ID",
      lifePlanConfirmed: true,
    });
    expect(await getClassReimbursementProfile(pool, person.id)).toMatchObject({
      payableTo: "Xcellent Staffing",
      budgetCategory: "Community classes",
    });
    const partial = unwrap(await saveClassReimbursementProfile(pool, person.id, {
      phone: "845-555-0199",
    }, ACTOR));
    expect(partial).toMatchObject({
      addressLine1: "100 Main Street",
      medicaidId: "SENSITIVE-SAMPLE-ID",
      phone: "845-555-0199",
      lifePlanConfirmed: true,
    });
    const { rows } = await pool.query<{ metadata: string }>(
      `SELECT metadata::text AS metadata
         FROM audit_logs
        WHERE action = 'class_reimbursement_profile_saved' AND entity_id = $1`,
      [person.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.metadata).not.toContain("SENSITIVE-SAMPLE-ID");
      expect(row.metadata).not.toContain("100 Main Street");
    }
  });

  it("preserves concurrent partial reimbursement profile saves", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Concurrent Profile" }, ACTOR));
    unwrap(await saveClassReimbursementProfile(pool, person.id, {
      mailingName: "Concurrent Profile",
      addressLine1: "100 Original Street",
      phone: "845-555-0100",
    }, ACTOR));

    const blocker = await pool.connect();
    let blockerCommitted = false;
    let readyCount = 0;
    let signalReady!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      signalReady = () => {
        readyCount += 1;
        if (readyCount === 2) resolve();
      };
    });
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    const bothReadyOrTimeout = Promise.race([
      bothReady,
      new Promise<never>((_, reject) => {
        readyTimeout = setTimeout(
          () => reject(new Error("Concurrent profile saves did not reach the serialization point.")),
          2_000,
        );
      }),
    ]);
    let saves!: Promise<Awaited<ReturnType<typeof saveClassReimbursementProfile>>[]>;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM individuals WHERE id = $1 FOR UPDATE`, [person.id]);
      await blocker.query(
        `SELECT id FROM class_reimbursement_profiles WHERE individual_id = $1 FOR UPDATE`,
        [person.id],
      );
      saves = Promise.all([
        saveClassReimbursementProfile(
          signaledProfilePool(signalReady),
          person.id,
          { phone: "845-555-0199" },
          ACTOR,
        ),
        saveClassReimbursementProfile(
          signaledProfilePool(signalReady),
          person.id,
          { addressLine1: "200 Concurrent Avenue" },
          ACTOR,
        ),
      ]);
      await bothReadyOrTimeout;
      await blocker.query("COMMIT");
      blockerCommitted = true;
    } finally {
      if (readyTimeout) clearTimeout(readyTimeout);
      if (!blockerCommitted) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    expect((await saves).every((result) => result.ok)).toBe(true);
    expect(await getClassReimbursementProfile(pool, person.id)).toMatchObject({
      phone: "845-555-0199",
      addressLine1: "200 Concurrent Avenue",
    });
  });

  it("freezes the first cover-sheet profile for an issued invoice", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Snapshot Person" }, ACTOR));
    const budget = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "20000",
    }, ACTOR));
    const [activityId] = await activityIds();
    const draft = unwrap(await createClassInvoiceDraft(pool, {
      classBudgetPeriodId: budget.id,
      invoiceNumber: "SNAPSHOT-1",
      invoiceDate: "2026-08-02",
      servicePeriodStart: "2026-07-01",
      servicePeriodEnd: "2026-07-31",
      lines: [{ activityId, serviceDate: "2026-07-01" }],
    }, ACTOR));
    const issued = unwrap(await issueClassInvoice(pool, draft.id, ACTOR));
    const unconfirmed = unwrap(await saveClassReimbursementProfile(pool, person.id, {
      mailingName: "Snapshot Person",
      addressLine1: "100 Original Street",
    }, ACTOR));
    expect(unconfirmed.lifePlanConfirmed).toBe(false);
    await expect(createClassCoverSheetSnapshot(pool, issued.id, unconfirmed, ACTOR))
      .resolves.toMatchObject({ ok: false, code: "validation" });
    const firstProfile = unwrap(await saveClassReimbursementProfile(pool, person.id, {
      mailingName: "Snapshot Person",
      addressLine1: "100 Original Street",
      medicaidId: "ORIGINAL-ID",
      lifePlanConfirmed: true,
    }, ACTOR));

    const frozen = unwrap(await createClassCoverSheetSnapshot(pool, issued.id, firstProfile, ACTOR));
    expect(frozen).toMatchObject({ addressLine1: "100 Original Street", medicaidId: "ORIGINAL-ID" });
    await saveClassReimbursementProfile(pool, person.id, {
      mailingName: "Snapshot Person",
      addressLine1: "200 New Street",
      medicaidId: "NEW-ID",
      lifePlanConfirmed: true,
    }, ACTOR);

    expect(await getClassCoverSheetSnapshot(pool, issued.id)).toMatchObject({
      addressLine1: "100 Original Street",
      medicaidId: "ORIGINAL-ID",
    });
    await expect(pool.query(
      `UPDATE class_cover_sheet_snapshots SET profile_snapshot = '{}'::jsonb WHERE class_invoice_id = $1`,
      [issued.id],
    )).rejects.toThrow(/immutable/i);
  });
});

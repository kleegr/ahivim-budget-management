import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import { agencyMonth } from "@/lib/business/agency-time";
import { getPortalHomeReadModel } from "@/lib/data/portal-read-model";
import { runMigrations } from "@/lib/db/migrate";
import {
  setAgencyIndividualMembership,
} from "@/lib/manage/agencies";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;

suite("agency membership interval history (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    await runMigrations(testPool());
  }, 60_000);
  afterAll(closeTestPool);

  it("date-matches facts to closed intervals and preserves history across end and restart", async () => {
    const pool = testPool();
    const actor = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ('membership-history@example.test', 'Membership Test', 'x', 'admin')
       RETURNING id`,
    );
    const agency = await pool.query<{ id: string }>(
      `INSERT INTO agencies (code, name) VALUES ('HISTORY_TEST', 'History Test Agency') RETURNING id`,
    );
    const individual = await pool.query<{ id: string }>(
      `INSERT INTO individuals (normalized_name, display_name)
       VALUES ('history person', 'History Person') RETURNING id`,
    );
    const actorId = actor.rows[0]!.id;
    const agencyId = agency.rows[0]!.id;
    const individualId = individual.rows[0]!.id;

    await pool.query(
      `INSERT INTO agency_individuals
         (agency_id, individual_id, manages_budget, bills_services, effective_from, effective_to)
       VALUES ($1, $2, false, true, '2024-01-01', '2024-01-31')`,
      [agencyId, individualId],
    );
    await pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, check_date, imported_amount, transaction_fingerprint)
       VALUES ($1, '2024-01-15', 100, 'membership-history-inside'),
              ($1, '2024-02-15', 900, 'membership-history-outside')`,
      [individualId],
    );

    const context: PortalAccessContext = {
      userId: actorId,
      globalRoles: [],
      individualLinks: [],
      employeeLinks: [],
      agencyAccess: [{
        agencyId,
        agencyCode: "HISTORY_TEST",
        agencyName: "History Test Agency",
        role: "agency",
        grants: [],
        denials: [],
      }],
    };
    const january = await getPortalHomeReadModel(pool, context, "2024-01");
    const february = await getPortalHomeReadModel(pool, context, "2024-02");
    expect(january.agencies.find((entry) => entry.id === agencyId)?.billedThisMonth).toBe("100.0000");
    expect(january.agencies.find((entry) => entry.id === agencyId)?.individuals?.[0]?.managesBudget).toBe(false);
    expect(february.agencies.find((entry) => entry.id === agencyId)?.billedThisMonth).toBe("0.0000");

    await expect(pool.query(
      `INSERT INTO agency_individuals
         (agency_id, individual_id, manages_budget, bills_services, effective_from, effective_to)
       VALUES ($1, $2, true, true, '2024-01-20', '2024-02-10')`,
      [agencyId, individualId],
    )).rejects.toMatchObject({ code: "23P01" });

    const today = await pool.query<{ today: string; tomorrow: string }>(
      `SELECT ((now() AT TIME ZONE 'America/New_York')::date)::text AS today,
              (((now() AT TIME ZONE 'America/New_York')::date + 1))::text AS tomorrow`,
    );
    const restored = await setAgencyIndividualMembership(pool, agencyId, {
      individualId,
      managesBudget: true,
      billsServices: true,
      effectiveFrom: today.rows[0]!.today,
    }, actorId, "Restart relationship");
    expect(restored.ok).toBe(true);
    const januaryAfterResponsibilityChange = await getPortalHomeReadModel(pool, context, "2024-01");
    const currentResponsibility = await getPortalHomeReadModel(pool, context, agencyMonth());
    expect(januaryAfterResponsibilityChange.agencies
      .find((entry) => entry.id === agencyId)?.individuals?.[0]?.managesBudget).toBe(false);
    expect(currentResponsibility.agencies
      .find((entry) => entry.id === agencyId)?.individuals?.[0]?.managesBudget).toBe(true);
    const ended = await setAgencyIndividualMembership(pool, agencyId, {
      individualId,
      managesBudget: true,
      billsServices: true,
      isActive: false,
    }, actorId, "End current relationship");
    expect(ended.ok).toBe(true);

    const intervals = await pool.query<{
      effective_from: string;
      effective_to: string | null;
      is_active: boolean;
    }>(
      `SELECT effective_from::text, effective_to::text, is_active
         FROM agency_individuals
        WHERE agency_id = $1 AND individual_id = $2
        ORDER BY effective_from`,
      [agencyId, individualId],
    );
    expect(intervals.rows).toEqual([
      { effective_from: "2024-01-01", effective_to: "2024-01-31", is_active: true },
      {
        effective_from: today.rows[0]!.today,
        effective_to: today.rows[0]!.today,
        is_active: true,
      },
    ]);

    const restarted = await setAgencyIndividualMembership(pool, agencyId, {
      individualId,
      managesBudget: true,
      billsServices: true,
      effectiveFrom: today.rows[0]!.tomorrow,
    }, actorId, "New interval after closed history");
    expect(restarted.ok).toBe(true);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agency_individuals
        WHERE agency_id = $1 AND individual_id = $2 AND is_active = true`,
      [agencyId, individualId],
    )).rows[0]?.count).toBe("3");
  }, 60_000);
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  setAgencyEmployeeMembership,
  setAgencyIndividualMembership,
} from "@/lib/manage/agencies";

const AGENCY = "00000000-0000-4000-8000-000000000010";
const INDIVIDUAL = "00000000-0000-4000-8000-000000000011";
const EMPLOYEE = "00000000-0000-4000-8000-000000000012";
const ACTOR = "00000000-0000-4000-8000-000000000013";
const MEMBERSHIP = "00000000-0000-4000-8000-000000000014";

interface Statement {
  sql: string;
  params?: unknown[];
}

function membershipPool(options: {
  individualCurrent?: Record<string, unknown>;
  employeeCurrent?: Record<string, unknown>;
  overlapOnInsert?: boolean;
} = {}): { pool: PgLikePool; statements: Statement[] } {
  const statements: Statement[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ agency_exists: true, person_exists: true }], rowCount: 1 };
    }
    if (sql.includes("FROM agency_individuals") && sql.includes("FOR UPDATE")) {
      return { rows: options.individualCurrent ? [options.individualCurrent] : [], rowCount: options.individualCurrent ? 1 : 0 };
    }
    if (sql.includes("FROM agency_employees") && sql.includes("FOR UPDATE")) {
      return { rows: options.employeeCurrent ? [options.employeeCurrent] : [], rowCount: options.employeeCurrent ? 1 : 0 };
    }
    if (options.overlapOnInsert && sql.includes("INSERT INTO agency_")) {
      throw Object.assign(new Error("overlap"), { code: "23P01" });
    }
    if (sql.includes("UPDATE agency_individuals") || sql.includes("UPDATE agency_employees")) {
      return { rows: [{ effective_to: "2026-08-28" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO agency_individuals") || sql.includes("INSERT INTO agency_employees")) {
      return { rows: [{ id: MEMBERSHIP }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return {
    pool: { connect: vi.fn(async () => client), query } as unknown as PgLikePool,
    statements,
  };
}

describe("effective-dated agency membership history", () => {
  it("ends the current interval without deleting or invalidating its history", async () => {
    const { pool, statements } = membershipPool({
      individualCurrent: {
        id: MEMBERSHIP,
        manages_budget: true,
        bills_services: true,
        effective_from: "2026-01-01",
        effective_to: null,
      },
    });

    const result = await setAgencyIndividualMembership(pool, AGENCY, {
      individualId: INDIVIDUAL,
      managesBudget: true,
      billsServices: true,
      isActive: false,
    }, ACTOR);

    expect(result.ok).toBe(true);
    const close = statements.find((entry) => entry.sql.includes("UPDATE agency_individuals"));
    expect(close?.sql).toContain("SET effective_to");
    expect(close?.sql).not.toContain("is_active = false");
    expect(close?.params?.[0]).toBe(MEMBERSHIP);
    expect(statements.some((entry) => /DELETE FROM agency_individuals/.test(entry.sql))).toBe(false);
    expect(statements.map((entry) => entry.sql).join("\n")).toContain("AT TIME ZONE 'America/New_York'");
    expect(statements.find((entry) => entry.sql.includes("INSERT INTO audit_logs"))?.params?.[1])
      .toBe("agency_individual_membership_ended");
  });

  it("closes current terms before inserting the replacement interval", async () => {
    const { pool, statements } = membershipPool({
      employeeCurrent: { id: MEMBERSHIP, effective_from: "2026-01-01", effective_to: null },
    });

    const result = await setAgencyEmployeeMembership(pool, AGENCY, {
      employeeId: EMPLOYEE,
      isActive: true,
      effectiveFrom: "2026-09-01",
    }, ACTOR);

    expect(result.ok).toBe(true);
    const closeIndex = statements.findIndex((entry) => entry.sql.includes("UPDATE agency_employees"));
    const insertIndex = statements.findIndex((entry) => entry.sql.includes("INSERT INTO agency_employees"));
    expect(closeIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(closeIndex);
    expect(statements[closeIndex]?.sql).toContain("effective_to = ($2::date - 1)");
    expect(statements[closeIndex]?.params?.[1]).toBe("2026-09-01");
    expect(statements[insertIndex]?.sql).toContain("VALUES ($1, $2, true");
  });

  it("restores an ended relationship by inserting a new interval", async () => {
    const { pool, statements } = membershipPool();

    const result = await setAgencyIndividualMembership(pool, AGENCY, {
      individualId: INDIVIDUAL,
      managesBudget: false,
      billsServices: true,
      isActive: true,
      effectiveFrom: "2026-09-01",
    }, ACTOR);

    expect(result.ok).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("UPDATE agency_individuals"))).toBe(false);
    expect(statements.some((entry) => entry.sql.includes("INSERT INTO agency_individuals"))).toBe(true);
    expect(statements.find((entry) => entry.sql.includes("INSERT INTO audit_logs"))?.params?.[1])
      .toBe("agency_individual_membership_started");
  });

  it("uses the validity flag only to cancel a future interval", async () => {
    const { pool, statements } = membershipPool();

    const result = await setAgencyEmployeeMembership(pool, AGENCY, {
      membershipId: MEMBERSHIP,
      employeeId: EMPLOYEE,
      isActive: false,
    }, ACTOR);

    expect(result.ok).toBe(true);
    const cancellation = statements.find((entry) => entry.sql.includes("UPDATE agency_employees"));
    expect(cancellation?.sql).toContain("SET is_active = false");
    expect(cancellation?.sql).toContain("effective_from > (now() AT TIME ZONE 'America/New_York')::date");
    expect(statements.some((entry) => entry.sql.includes("INSERT INTO agency_employees"))).toBe(false);
    expect(statements.find((entry) => entry.sql.includes("INSERT INTO audit_logs"))?.params?.[1])
      .toBe("agency_employee_membership_cancelled");
  });

  it("returns a conflict when the database overlap guard rejects an interval", async () => {
    const { pool, statements } = membershipPool({ overlapOnInsert: true });

    const result = await setAgencyEmployeeMembership(pool, AGENCY, {
      employeeId: EMPLOYEE,
      effectiveFrom: "2026-09-01",
    }, ACTOR);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(statements.some((entry) => entry.sql === "ROLLBACK")).toBe(true);
    expect(statements.some((entry) => entry.sql === "COMMIT")).toBe(false);
  });

  it("keeps the migration and Drizzle mirror on the surrogate interval model", () => {
    const migration = readFileSync("drizzle/0029_agencies_portal_access.sql", "utf8");
    const schema = readFileSync("src/lib/db/schema.ts", "utf8");

    for (const table of ["agency_individuals", "agency_employees"]) {
      const create = migration.slice(migration.indexOf(`CREATE TABLE "${table}"`));
      expect(create.slice(0, create.indexOf(");--> statement-breakpoint")))
        .toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL');
      expect(migration).toContain(`CREATE TRIGGER "${table}_non_overlap_guard"`);
    }
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("AT TIME ZONE 'America/New_York'");
    expect(migration).not.toMatch(/\bcurrent_date\b/i);
    expect(migration).toContain("daterange(existing.\"effective_from\", existing.\"effective_to\", '[]')");
    expect(migration).toContain('min(fact."fact_on") AS "first_fact_on"');
    expect(migration).toContain('(i."created_at" AT TIME ZONE \'America/New_York\')::date');
    expect(migration).toContain('canonical_service_date(t."period_begin", t."check_date", t."period_end")');
    expect(migration).not.toContain('t."created_at"::date');
    expect(schema).toMatch(/agencyIndividuals = pgTable\([\s\S]*?id: uuid\("id"\)\.primaryKey\(\)\.defaultRandom\(\)/);
    expect(schema).toMatch(/agencyEmployees = pgTable\([\s\S]*?id: uuid\("id"\)\.primaryKey\(\)\.defaultRandom\(\)/);
  });

  it("moves nonoverlapping interval rows during identity merges instead of collapsing history", () => {
    const individualMerge = readFileSync("src/lib/manage/individual-merge.ts", "utf8");
    const employeeMerge = readFileSync("src/lib/manage/employee-merge.ts", "utf8");

    expect(individualMerge).toContain("Resolve overlapping agency membership history");
    expect(individualMerge).toContain("UPDATE agency_individuals");
    expect(individualMerge).not.toMatch(/INSERT INTO agency_individuals[\s\S]*?ON CONFLICT/);
    expect(employeeMerge).toContain("Resolve overlapping agency membership history");
    expect(employeeMerge).toContain("UPDATE agency_employees");
    expect(employeeMerge).not.toMatch(/INSERT INTO agency_employees[\s\S]*?ON CONFLICT/);
  });
});

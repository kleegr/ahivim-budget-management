import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "drizzle/0033_home_agency_budget_responsibility.sql",
  "utf8",
);

describe("home-agency budget responsibility migration", () => {
  it("backfills active sources in both directions", () => {
    expect(migration).toContain('agency."is_home_agency" = true');
    expect(migration).toMatch(/FROM "calculation_strategies" strategy[\s\S]*strategy\."status" = 'active'/);
    expect(migration).toMatch(/FROM "budget_authorizations" budget_auth[\s\S]*budget_auth\."status" = 'active'/);
    expect(migration).toMatch(/budget_auth\."archived_at" IS NULL/);
    expect(migration).toMatch(/SET "manages_budget" = \([\s\S]*NOT membership\."bills_services"/);
    expect(migration).toMatch(/membership\."manages_budget" IS DISTINCT FROM \(/);
  });

  it("includes current and future active home memberships without rewriting ended history", () => {
    expect(migration).not.toContain('membership."effective_from" <=');
    expect(migration.match(/membership\."effective_to" IS NULL/g)).toHaveLength(2);
    expect(migration.match(/membership\."effective_to" >=/g)).toHaveLength(2);
    expect(migration.match(/agency\."is_home_agency" = true/g)).toHaveLength(2);
  });

  it("recomputes active sources in both directions without touching external agencies", () => {
    expect(migration).toContain('CREATE FUNCTION "sync_home_agency_budget_managed"("target_individual_id" uuid)');
    expect(migration).toContain('CREATE FUNCTION "sync_home_agency_budget_managed_from_source"()');
    expect(migration).toContain('CREATE TRIGGER "calculation_strategies_mark_home_budget_managed"');
    expect(migration).toContain('CREATE TRIGGER "budget_authorizations_mark_home_budget_managed"');
    expect(migration).toMatch(/SET "manages_budget" = inferred\."manages_budget"/);
    expect(migration).toMatch(/membership\."manages_budget" IS DISTINCT FROM inferred\."manages_budget"/);
    expect(migration).toMatch(/NOT membership\."bills_services"[\s\S]*strategy\."status" = 'active'/);
    expect(migration).toMatch(/budget_auth\."status" = 'active'[\s\S]*budget_auth\."archived_at" IS NULL/);
    expect(migration).toContain("IF TG_OP = 'DELETE' THEN");
    expect(migration).toContain('OLD."individual_id" IS DISTINCT FROM NEW."individual_id"');
    expect(migration).toMatch(
      /CREATE TRIGGER "budget_authorizations_mark_home_budget_managed"[\s\S]*AFTER INSERT OR DELETE OR UPDATE OF "status", "individual_id", "archived_at"/,
    );
  });
});

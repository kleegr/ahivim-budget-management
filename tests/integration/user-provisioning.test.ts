import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";
import { provisionUser } from "@/lib/auth/provision-user";
import { createUser, listUsersWithAccess } from "@/lib/auth/users";

const suite = hasTestDatabase ? describe : describe.skip;
const MISSING_INDIVIDUAL = "00000000-0000-4000-8000-000000000099";

suite("preset user provisioning (real PostgreSQL)", () => {
  beforeAll(resetSchema, 60_000);
  beforeEach(truncateBusinessTables);
  afterAll(closeTestPool);

  async function seedActor() {
    const result = await createUser(testPool(), {
      email: "actor@example.test",
      displayName: "Current Owner",
      password: "current owner password",
      role: "admin",
    }, null);
    if (!result.ok) throw new Error(`Could not seed actor: ${result.reason}`);
    return result.user;
  }

  it("creates Owner as both an administrator and global portal owner", async () => {
    const actor = await seedActor();
    const result = await provisionUser(testPool(), {
      preset: "owner",
      email: "new-owner@example.test",
      displayName: "New Owner",
      password: "new owner password",
    }, actor.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await testPool().query<{ role: string; portal_role: string }>(
      `SELECT u.role, portal.portal_role
         FROM users u
         JOIN user_portal_roles portal ON portal.user_id = u.id AND portal.is_active = true
        WHERE u.id = $1`,
      [result.data.id],
    );
    expect(stored.rows).toEqual([{ role: "admin", portal_role: "owner" }]);
    expect((await listUsersWithAccess(testPool()))
      .find((user) => user.id === result.data.id)?.accountPreset).toBe("owner");
  });

  it("creates direct and agency portal identities without legacy internal grants", async () => {
    const actor = await seedActor();
    const individual = await testPool().query<{ id: string }>(
      `INSERT INTO individuals (normalized_name, display_name)
       VALUES ('portal-individual', 'Portal Individual') RETURNING id`,
    );
    const employee = await testPool().query<{ id: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('portal-employee', 'Portal Employee') RETURNING id`,
    );
    const agency = await testPool().query<{ id: string }>(
      `INSERT INTO agencies (code, name, created_by_user_id, updated_by_user_id)
       VALUES ('PORTAL', 'Portal Agency', $1, $1) RETURNING id`,
      [actor.id],
    );

    const parent = await provisionUser(testPool(), {
      preset: "individual_parent",
      email: "parent@example.test",
      displayName: "Parent",
      password: "parent temporary password",
      individualId: individual.rows[0]!.id,
      relationship: "guardian",
    }, actor.id);
    const ownEmployee = await provisionUser(testPool(), {
      preset: "employee",
      email: "employee@example.test",
      displayName: "Employee",
      password: "employee temporary password",
      employeeId: employee.rows[0]!.id,
    }, actor.id);
    const scheduler = await provisionUser(testPool(), {
      preset: "agency_scheduler",
      email: "scheduler@example.test",
      displayName: "Scheduler",
      password: "scheduler temporary password",
      agencyId: agency.rows[0]!.id,
    }, actor.id);

    expect(parent.ok && ownEmployee.ok && scheduler.ok).toBe(true);
    if (!parent.ok || !ownEmployee.ok || !scheduler.ok) return;

    const bindings = await testPool().query<{
      parent_role: string;
      relationship_type: string;
      employee_role: string;
      employee_relationship: string;
      agency_role: string;
    }>(
      `SELECT
         (SELECT portal_role FROM user_portal_roles WHERE user_id = $1 AND is_active = true) AS parent_role,
         (SELECT relationship_type FROM user_individual_relationships WHERE user_id = $1 AND is_active = true) AS relationship_type,
         (SELECT portal_role FROM user_portal_roles WHERE user_id = $2 AND is_active = true) AS employee_role,
         (SELECT relationship_type FROM user_employee_relationships WHERE user_id = $2 AND is_active = true) AS employee_relationship,
         (SELECT portal_role FROM user_agency_access WHERE user_id = $3 AND is_active = true) AS agency_role`,
      [parent.data.id, ownEmployee.data.id, scheduler.data.id],
    );
    expect(bindings.rows[0]).toEqual({
      parent_role: "parent",
      relationship_type: "guardian",
      employee_role: "employee",
      employee_relationship: "self",
      agency_role: "scheduler",
    });

    const legacyGrants = await testPool().query<{ individual_count: number; employee_count: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM user_individual_access WHERE user_id = ANY($1::uuid[])) AS individual_count,
         (SELECT COUNT(*)::int FROM user_employee_access WHERE user_id = ANY($1::uuid[])) AS employee_count`,
      [[parent.data.id, ownEmployee.data.id, scheduler.data.id]],
    );
    expect(legacyGrants.rows[0]).toEqual({ individual_count: 0, employee_count: 0 });

    const listed = await listUsersWithAccess(testPool());
    expect(listed.find((user) => user.id === parent.data.id)?.accountPreset).toBe("individual_parent");
    expect(listed.find((user) => user.id === ownEmployee.data.id)?.accountPreset).toBe("employee");
    expect(listed.find((user) => user.id === scheduler.data.id)?.accountPreset).toBe("agency_scheduler");
  });

  it("rolls back the login and its global role when a direct binding fails", async () => {
    const actor = await seedActor();
    const result = await provisionUser(testPool(), {
      preset: "individual_parent",
      email: "orphan@example.test",
      displayName: "Should Roll Back",
      password: "rollback temporary password",
      individualId: MISSING_INDIVIDUAL,
      relationship: "parent",
    }, actor.id);

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    const stored = await testPool().query<{ users: number; roles: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM users WHERE email = 'orphan@example.test') AS users,
         (SELECT COUNT(*)::int FROM user_portal_roles role
           JOIN users u ON u.id = role.user_id WHERE u.email = 'orphan@example.test') AS roles`,
    );
    expect(stored.rows[0]).toEqual({ users: 0, roles: 0 });
  });
});

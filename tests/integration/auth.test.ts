import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool, countRows,
} from "../support/database";
import {
  authenticate, changePassword, createUser, findUserByEmail, listUsers,
  setUserActive, setUserRole, userCount, writeAudit, normalizeEmail,
} from "@/lib/auth/users";
import { hashPassword, verifyPassword, signSession, readSession } from "@/lib/auth/crypto";
import { roleAtLeast, safeRedirectPath } from "@/lib/auth/session";

const suite = hasTestDatabase ? describe : describe.skip;

const ADMIN = { email: "admin@example.test", password: "correct horse battery" };

suite("authentication and authorization (real PostgreSQL)", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET = "test-secret-for-session-signing";
    await resetSchema();
  }, 60_000);
  beforeEach(truncateBusinessTables);
  afterAll(closeTestPool);

  async function seedAdmin() {
    const result = await createUser(
      testPool(),
      { email: ADMIN.email, displayName: "Admin", password: ADMIN.password, role: "admin" },
      null,
    );
    if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
    return result.user;
  }

  it("accepts correct credentials and records the sign-in", async () => {
    const user = await seedAdmin();
    const outcome = await authenticate(testPool(), ADMIN.email, ADMIN.password);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.user.id).toBe(user.id);
    expect(outcome.user.role).toBe("admin");

    const stored = await findUserByEmail(testPool(), ADMIN.email);
    expect(stored?.lastLoginAt).not.toBeNull();
  });

  it("rejects a wrong password without revealing which field was wrong", async () => {
    await seedAdmin();
    const outcome = await authenticate(testPool(), ADMIN.email, "not the password");
    expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("gives an unknown email the same rejection as a wrong password", async () => {
    await seedAdmin();
    const unknown = await authenticate(testPool(), "nobody@example.test", "whatever at all");
    expect(unknown).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("is case-insensitive on the email address", async () => {
    await seedAdmin();
    const outcome = await authenticate(testPool(), "ADMIN@Example.TEST", ADMIN.password);
    expect(outcome.ok).toBe(true);
    expect(normalizeEmail("  Mixed@CASE.com ")).toBe("mixed@case.com");
  });

  it("refuses a disabled account even with the right password", async () => {
    const user = await seedAdmin();
    await setUserActive(testPool(), user.id, false, null);
    const outcome = await authenticate(testPool(), ADMIN.email, ADMIN.password);
    expect(outcome).toEqual({ ok: false, reason: "account_disabled" });
  });

  it("never stores a plaintext password", async () => {
    await seedAdmin();
    const stored = await findUserByEmail(testPool(), ADMIN.email);
    expect(stored?.passwordHash).not.toContain(ADMIN.password);
    expect(stored?.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(ADMIN.password, stored!.passwordHash)).toBe(true);
  });

  it("produces a different hash for the same password each time (random salt)", async () => {
    const a = await hashPassword("a shared password");
    const b = await hashPassword("a shared password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("a shared password", a)).toBe(true);
    expect(await verifyPassword("a shared password", b)).toBe(true);
  });

  describe("bootstrap administrator", () => {
    it("creates the first admin from BOOTSTRAP_ADMIN_* while the table is empty", async () => {
      process.env.BOOTSTRAP_ADMIN_EMAIL = "boot@example.test";
      process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap password 1";
      expect(await userCount(testPool())).toBe(0);

      const outcome = await authenticate(testPool(), "boot@example.test", "bootstrap password 1");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.bootstrapped).toBe(true);
      expect(outcome.user.role).toBe("admin");
      expect(await userCount(testPool())).toBe(1);
    });

    it("closes the window as soon as any user exists", async () => {
      process.env.BOOTSTRAP_ADMIN_EMAIL = "boot@example.test";
      process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap password 1";
      await seedAdmin();
      const outcome = await authenticate(testPool(), "boot@example.test", "bootstrap password 1");
      expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
      expect(await userCount(testPool())).toBe(1);
    });

    it("does not bootstrap on a wrong password, so it is not a public signup", async () => {
      process.env.BOOTSTRAP_ADMIN_EMAIL = "boot@example.test";
      process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap password 1";
      const outcome = await authenticate(testPool(), "boot@example.test", "guessing this one");
      expect(outcome.ok).toBe(false);
      expect(await userCount(testPool())).toBe(0);
    });

    it("does nothing when the variables are unset", async () => {
      delete process.env.BOOTSTRAP_ADMIN_EMAIL;
      delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
      const outcome = await authenticate(testPool(), "anyone@example.test", "any password here");
      expect(outcome.ok).toBe(false);
      expect(await userCount(testPool())).toBe(0);
    });
  });

  describe("password change", () => {
    it("changes the password and lets the new one sign in", async () => {
      const user = await seedAdmin();
      const result = await changePassword(testPool(), user.id, ADMIN.password, "a brand new one");
      expect(result.ok).toBe(true);
      expect((await authenticate(testPool(), ADMIN.email, "a brand new one")).ok).toBe(true);
      expect((await authenticate(testPool(), ADMIN.email, ADMIN.password)).ok).toBe(false);
    });

    it("refuses when the current password is wrong", async () => {
      const user = await seedAdmin();
      const result = await changePassword(testPool(), user.id, "wrong current", "a brand new one");
      expect(result).toEqual({ ok: false, reason: "incorrect_current" });
      expect((await authenticate(testPool(), ADMIN.email, ADMIN.password)).ok).toBe(true);
    });

    it("refuses a password shorter than ten characters", async () => {
      const user = await seedAdmin();
      expect(await changePassword(testPool(), user.id, ADMIN.password, "short")).toEqual({
        ok: false,
        reason: "too_short",
      });
    });

    it("refuses reusing the current password", async () => {
      const user = await seedAdmin();
      expect(await changePassword(testPool(), user.id, ADMIN.password, ADMIN.password)).toEqual({
        ok: false,
        reason: "reused",
      });
    });

    it("writes an audit record", async () => {
      const user = await seedAdmin();
      await changePassword(testPool(), user.id, ADMIN.password, "a brand new one");
      const { rows } = await testPool().query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE action = 'password_changed'`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("roles", () => {
    it("ranks viewer < manager < admin", () => {
      expect(roleAtLeast("admin", "manager")).toBe(true);
      expect(roleAtLeast("manager", "manager")).toBe(true);
      expect(roleAtLeast("viewer", "manager")).toBe(false);
      expect(roleAtLeast("manager", "admin")).toBe(false);
      expect(roleAtLeast(undefined, "viewer")).toBe(false);
      expect(roleAtLeast("superuser", "viewer")).toBe(false);
    });

    it("rejects an unknown role at creation", async () => {
      const result = await createUser(
        testPool(),
        { email: "x@example.test", displayName: "X", password: "a good password", role: "root" },
        null,
      );
      expect(result).toEqual({ ok: false, reason: "invalid_role" });
      expect(await countRows("users")).toBe(0);
    });

    it("rejects a duplicate email", async () => {
      await seedAdmin();
      const again = await createUser(
        testPool(),
        { email: ADMIN.email, displayName: "Dupe", password: "another password", role: "viewer" },
        null,
      );
      expect(again).toEqual({ ok: false, reason: "duplicate_email" });
      expect(await countRows("users")).toBe(1);
    });

    it("changes a role and records it", async () => {
      const admin = await seedAdmin();
      const created = await createUser(
        testPool(),
        { email: "v@example.test", displayName: "V", password: "viewer password", role: "viewer" },
        admin.id,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(await setUserRole(testPool(), created.user.id, "manager", admin.id)).toBe(true);
      const users = await listUsers(testPool());
      expect(users.find((u) => u.id === created.user.id)?.role).toBe("manager");
      expect(await setUserRole(testPool(), created.user.id, "wizard", admin.id)).toBe(false);
    });
  });

  describe("session cookies", () => {
    it("round-trips a signed payload", () => {
      const token = signSession({
        userId: "u-1", role: "admin", displayName: "A", exp: Date.now() + 60_000,
      });
      expect(readSession(token)?.userId).toBe("u-1");
    });

    it("rejects a tampered payload", () => {
      const token = signSession({
        userId: "u-1", role: "viewer", displayName: "A", exp: Date.now() + 60_000,
      });
      const [body, mac] = token.split(".");
      const forged = Buffer.from(
        JSON.stringify({ userId: "u-1", role: "admin", displayName: "A", exp: Date.now() + 60_000 }),
      ).toString("base64url");
      expect(readSession(`${forged}.${mac}`)).toBeNull();
      expect(readSession(`${body}.${mac.slice(0, -1)}x`)).toBeNull();
      expect(readSession("not-a-token")).toBeNull();
      expect(readSession(undefined)).toBeNull();
    });

    it("rejects an expired payload", () => {
      const token = signSession({
        userId: "u-1", role: "admin", displayName: "A", exp: Date.now() - 1,
      });
      expect(readSession(token)).toBeNull();
    });
  });

  describe("redirect safety", () => {
    it("only accepts relative single-slash paths", () => {
      expect(safeRedirectPath("/imports")).toBe("/imports");
      expect(safeRedirectPath("//evil.example")).toBe("/dashboard");
      expect(safeRedirectPath("https://evil.example")).toBe("/dashboard");
      expect(safeRedirectPath("/\\evil.example")).toBe("/dashboard");
      expect(safeRedirectPath("/signin")).toBe("/dashboard");
      expect(safeRedirectPath(null)).toBe("/dashboard");
    });
  });

  it("writes audit rows without a user for anonymous events", async () => {
    await writeAudit(testPool(), { action: "login_failed", metadata: { email: "x@y.z" } });
    expect(await countRows("audit_logs")).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ currentUser: mocks.currentUser }));

import { GET } from "@/app/api/health/env/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ role: "admin" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deployment integration readiness", () => {
  it("does not report malformed or partial integration secrets as configured", async () => {
    vi.stubEnv("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON", "not-json");
    vi.stubEnv("GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL", "sync@example.test");
    vi.stubEnv("GOOGLE_SHEETS_PRIVATE_KEY", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "   ");

    const body = await (await GET()).json() as Record<string, unknown>;

    expect(body.googleSheetWritebackConfigured).toBe(false);
    expect(body.documentStorageConfigured).toBe(false);
  });

  it("reports structurally complete Sheet credentials and private storage", async () => {
    vi.stubEnv("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON", JSON.stringify({
      client_email: "sync@example.test",
      private_key: "private-key-placeholder",
    }));
    vi.stubEnv("GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL", "");
    vi.stubEnv("GOOGLE_SHEETS_PRIVATE_KEY", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob-token-placeholder");

    const body = await (await GET()).json() as Record<string, unknown>;

    expect(body.googleSheetWritebackConfigured).toBe(true);
    expect(body.documentStorageConfigured).toBe(true);
  });

  it("returns only aggregate readiness to an anonymous caller", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://configured.example.test/ahivim");
    vi.stubEnv("CRON_SECRET", "cron-secret-placeholder");
    vi.stubEnv("MIGRATION_TOKEN", "migration-token-placeholder");
    mocks.currentUser.mockResolvedValue(null);

    const body = await (await GET()).json() as Record<string, unknown>;

    expect(body).toEqual({ ok: true, configured: true, detail: "public" });
    expect(body).not.toHaveProperty("cronSecretConfigured");
    expect(body).not.toHaveProperty("migrationTokenConfigured");
    expect(body).not.toHaveProperty("candidatesPresent");
  });
});

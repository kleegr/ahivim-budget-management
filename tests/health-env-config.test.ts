import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/env/route";

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
});

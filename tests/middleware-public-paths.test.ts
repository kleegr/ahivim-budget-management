import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

describe("middleware public path allowlist", () => {
  it.each([
    "/api/health/db",
    "/api/health/env",
    "/api/health/schema",
    "/api/health/xlsx",
    "/api/sync/cron",
    "/api/sync/bootstrap",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/documents/uploads",
  ])("allows the exact route handler to perform its own authorization: %s", (pathname) => {
    const response = middleware(new NextRequest(`http://localhost${pathname}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "/api/health/not-a-check",
    "/api/sync/cron-extra",
    "/api/sync/bootstrap-extra",
    "/api/auth/login-extra",
    "/api/documents/uploads-extra",
  ])("fails closed for a similarly named or unknown API: %s", async (pathname) => {
    const response = middleware(new NextRequest(`http://localhost${pathname}`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Authentication required",
    });
  });
});

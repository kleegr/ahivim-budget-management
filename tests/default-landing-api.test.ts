import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/app-settings", () => ({ setSetting: mocks.setSetting }));

import { POST } from "@/app/api/settings/default-landing/route";

function request(value: string) {
  return new NextRequest("http://localhost/api/settings/default-landing", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ value }),
  });
}

describe("default landing API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue({ id: "manager-1", role: "manager" });
    mocks.getPool.mockReturnValue({});
    mocks.setSetting.mockResolvedValue(undefined);
  });

  it.each(["dashboard", "transactions", "individuals", "calculations"])(
    "accepts the rendered %s landing choice",
    async (value) => {
      const response = await POST(request(value));

      expect(response.status).toBe(200);
      expect(mocks.setSetting).toHaveBeenCalledWith({}, "default_landing", value, "manager-1");
    },
  );

  it("rejects a landing page the interface does not offer", async () => {
    const response = await POST(request("settings"));

    expect(response.status).toBe(400);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });
});

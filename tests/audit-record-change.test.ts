import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAuditAttribution: vi.fn(),
}));

vi.mock("@/lib/auth/audit-attribution", () => ({
  resolveAuditAttribution: mocks.resolveAuditAttribution,
}));

import { recordChange } from "@/lib/manage/audit";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";

describe("operational audit writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAuditAttribution.mockResolvedValue({
      actorId: OWNER_ID,
      impersonatedUserId: TARGET_ID,
    });
  });

  it("stores the real actor and effective preview user together", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordChange({ query }, {
      actorId: TARGET_ID,
      action: "schedule_created",
      entityType: "scheduled_session",
      entityId: "session-1",
      extra: { source: "calendar" },
    });

    expect(query).toHaveBeenCalledOnce();
    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe(OWNER_ID);
    expect(JSON.parse(String(values[5]))).toEqual({
      source: "calendar",
      impersonatedUserId: TARGET_ID,
    });
  });
});

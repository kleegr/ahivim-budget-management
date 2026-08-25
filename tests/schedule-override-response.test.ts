import { describe, expect, it } from "vitest";
import { resultResponse } from "@/lib/http";
import { fail } from "@/lib/manage/errors";
import { SCHEDULE_OVERRIDE_REQUIRED_MESSAGE } from "@/lib/manage/schedule";

describe("schedule override HTTP response", () => {
  it("returns a friendly validation 400", async () => {
    const response = resultResponse(fail("validation", SCHEDULE_OVERRIDE_REQUIRED_MESSAGE));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: "validation",
      error: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    });
  });
});

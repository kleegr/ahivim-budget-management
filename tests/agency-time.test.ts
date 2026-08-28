import { describe, expect, it } from "vitest";
import { agencyDate, agencyMonth } from "@/lib/business/agency-time";

describe("agency business calendar", () => {
  it("stays on the New York date before local midnight", () => {
    const instant = new Date("2026-09-01T02:30:00.000Z");
    expect(agencyDate(instant)).toBe("2026-08-31");
    expect(agencyMonth(instant)).toBe("2026-08");
  });

  it("handles daylight-saving offsets without server-local assumptions", () => {
    expect(agencyDate(new Date("2026-01-01T04:30:00.000Z"))).toBe("2025-12-31");
    expect(agencyDate(new Date("2026-06-01T04:30:00.000Z"))).toBe("2026-06-01");
  });
});

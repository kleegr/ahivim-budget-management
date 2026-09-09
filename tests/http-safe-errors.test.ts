import { describe, expect, it, vi } from "vitest";
import { redactError, resultResponse } from "@/lib/http";
describe("safe HTTP error contract", () => {
  it("keeps SQL diagnostics and credentials out of responses and logs", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error("column private_payroll does not exist postgres://name:secret@prod/db"), { code: "42703" });
    expect(redactError(error, "Could not load the schedule.")).toBe("Could not load the schedule.");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private_payroll|secret|prod\/db/);
    expect(JSON.stringify(log.mock.calls)).toContain("42703");
    log.mockRestore();
  });
  it("preserves intentional domain validation", async () => {
    const response = resultResponse({ ok: false, code: "validation", message: "Enter a valid session date." });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Enter a valid session date.");
  });
});

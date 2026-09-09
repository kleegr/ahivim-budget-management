import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
}));

import { withDb } from "@/lib/data/pool";

describe("database-backed screen errors", () => {
  it("records the diagnostic without exposing it in the interface", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await withDb(async () => {
      throw Object.assign(new Error('column "private_table.secret_column" must appear in the GROUP BY clause'), { code: "42803" });
    });

    expect(result).toEqual({
      ok: false,
      error: "This information could not be loaded right now. Refresh the page in a moment.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[withDb] Database-backed view failed:",
      "Unknown database error",
    );
    expect(consoleError).toHaveBeenCalledWith("Request failed", { name: "Error", code: "42803" });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private_table");

    consoleError.mockRestore();
  });
});

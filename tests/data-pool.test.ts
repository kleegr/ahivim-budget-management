import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({})),
}));

import { withDb } from "@/lib/data/pool";

describe("database-backed screen errors", () => {
  it("records the diagnostic without exposing it in the interface", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await withDb(async () => {
      throw new Error('column "private_table.secret_column" must appear in the GROUP BY clause');
    });

    expect(result).toEqual({
      ok: false,
      error: "This information could not be loaded right now. Refresh the page in a moment.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[withDb] Database-backed view failed:",
      'column "private_table.secret_column" must appear in the GROUP BY clause',
    );

    consoleError.mockRestore();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attemptOptionalScheduleMatching } from "@/lib/sheets/sync";

const range = { from: "2026-08-01", to: "2026-08-31" };

describe("optional Sheet schedule matching", () => {
  it("records a completed check", async () => {
    const outcome = await attemptOptionalScheduleMatching(
      range,
      async () => ({ ok: true, data: { matched: 2, considered: 5 } }),
    );

    expect(outcome).toEqual({
      status: "checked",
      matched: 2,
      considered: 5,
      ...range,
      reviewHref: "/schedule?view=matching",
    });
  });

  it("keeps a domain failure retryable without throwing", async () => {
    const outcome = await attemptOptionalScheduleMatching(
      range,
      async () => ({ ok: false, code: "conflict", message: "try later" }),
    );

    expect(outcome.status).toBe("needs_review");
    expect(outcome).toMatchObject({ ...range, matched: 0, considered: 0 });
  });

  it("keeps an unexpected failure retryable without throwing", async () => {
    const outcome = await attemptOptionalScheduleMatching(range, async () => {
      throw new Error("temporary database timeout");
    });

    expect(outcome.status).toBe("needs_review");
    expect(outcome.reviewHref).toBe("/schedule?view=matching");
  });

  it("keeps unchanged-sync failure copy consistent and returns its retry action data", () => {
    const source = readFileSync("src/lib/sheets/sync.ts", "utf8");
    expect(source).toContain("The transaction data is saved");
    expect(source).not.toContain("Transactions were imported successfully. Automatic schedule matching needs attention");
    expect(source).toContain("reconciliation: scheduleMatching");
    expect(source).toContain("{ note: reconciliationNote, scheduleMatching }");
  });
});

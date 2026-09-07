import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("payroll-check audit attribution", () => {
  it("uses the responsible signer during owner preview", () => {
    const saveSource = readFileSync(
      join(process.cwd(), "src", "app", "api", "payroll-checks", "route.ts"),
      "utf8",
    );
    const importReviewSource = readFileSync(
      join(process.cwd(), "src", "app", "api", "payroll-checks", "import-reviews", "route.ts"),
      "utf8",
    );
    for (const source of [saveSource, importReviewSource]) {
      expect(source).toContain("operator.user.actorId");
      expect(source).not.toMatch(/\boperator\.user\.id\b/);
    }
  });
});

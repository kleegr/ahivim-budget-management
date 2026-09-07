import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = (...segments: string[]) => readFileSync(
  join(process.cwd(), "src", "app", "api", ...segments, "route.ts"),
  "utf8",
);

describe("planning write attribution", () => {
  it("uses the responsible signer for assignment and schedule mutations", () => {
    const sources = [
      routeSource("assignments"),
      routeSource("assignments", "[id]"),
      routeSource("schedule", "series"),
      routeSource("schedule", "series", "[id]"),
      routeSource("schedule", "sessions"),
      routeSource("schedule", "sessions", "[id]"),
    ];

    for (const source of sources) {
      expect(source).toContain("user.actorId");
    }
  });
});

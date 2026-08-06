/**
 * Playwright global setup. Runs once, before the web servers start, so the
 * database is already migrated and seeded by the time the application boots
 * (the app's own instrumentation migration then finds the schema current and
 * skips).
 *
 * The seed is executed as a separate `tsx` process rather than imported here,
 * to keep the application's TypeScript (and the Neon driver import graph) out of
 * Playwright's own module transform.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { TEST_DB_URL } from "./fixtures";

export default async function globalSetup(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const seedScript = path.join(repoRoot, "tests", "e2e", "seed.ts");

  console.log("[e2e] seeding test database…");
  execFileSync(tsx, [seedScript], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || TEST_DB_URL,
      DATABASE_URL: process.env.DATABASE_URL || TEST_DB_URL,
    },
  });
}

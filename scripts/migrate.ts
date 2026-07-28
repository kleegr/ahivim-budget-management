/**
 * Run migrations from a machine that can reach the database directly.
 *
 *   DATABASE_URL="postgres://..." npm run db:migrate
 *
 * The connection string is read from the environment and never printed.
 */
import { runMigrations, listTables } from "../src/lib/db/migrate";
import { resolveConnectionEnvName } from "../src/lib/db";

async function main() {
  const envName = resolveConnectionEnvName();
  if (!envName) {
    console.error("No database connection variable found. See .env.example.");
    process.exit(1);
  }
  console.log(`Using connection from ${envName}`);

  const result = await runMigrations();
  for (const outcome of result.outcomes) {
    console.log(`  ${outcome.status.padEnd(18)} ${outcome.name}`);
    if (outcome.error) console.log(`    ${outcome.error}`);
  }
  const tables = await listTables();
  console.log(`Applied ${result.applied}, skipped ${result.skipped}. ${tables.length} tables present.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

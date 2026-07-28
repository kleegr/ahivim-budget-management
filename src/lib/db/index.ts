import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

/**
 * Neon connection.
 *
 * The WebSocket pool driver is used rather than the HTTP driver because the
 * import commit must run inside a real database transaction — a partially
 * committed import is worse than a failed one.
 *
 * The connection string is read from the environment and is never logged,
 * echoed in an error message, or returned to a client.
 */

if (!globalThis.WebSocket) {
  neonConfig.webSocketConstructor = ws;
}

/**
 * Local development and end-to-end testing against a plain PostgreSQL.
 *
 * The Neon driver speaks the Postgres wire protocol over a WebSocket, so it
 * cannot talk to a local server directly. Setting NEON_WS_PROXY to a
 * host:port running a WebSocket-to-TCP bridge points it at one instead.
 *
 * Unset in production, where this block does nothing at all. It exists so the
 * built application can be exercised over real HTTP without a cloud database.
 */
if (process.env.NEON_WS_PROXY) {
  neonConfig.wsProxy = process.env.NEON_WS_PROXY;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
}

/** Candidate variable names, in priority order. */
export const CONNECTION_ENV_CANDIDATES = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
  "NEON_DATABASE_URL",
] as const;

/** Which variable is actually supplying the connection string. Name only. */
export function resolveConnectionEnvName(): string | null {
  for (const name of CONNECTION_ENV_CANDIDATES) {
    const value = process.env[name];
    if (value && value.trim() !== "") return name;
  }
  return null;
}

export function getConnectionString(): string {
  const name = resolveConnectionEnvName();
  if (!name) {
    throw new Error(
      "No database connection string found. Set one of: " +
        CONNECTION_ENV_CANDIDATES.join(", ") +
        ". See docs/deployment.md.",
    );
  }
  return process.env[name]!;
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getConnectionString() });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export { schema };

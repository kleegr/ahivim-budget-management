import { createHash } from "node:crypto";

export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n?/g, "\n");
}

function rawChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Canonical checksum written for every newly applied migration. */
export function migrationChecksum(sql: string): string {
  return rawChecksum(normalizeMigrationSql(sql));
}

/** Accept hashes written by older Windows or Unix checkouts of the same SQL. */
export function migrationChecksumMatches(storedChecksum: string, sql: string): boolean {
  const canonical = normalizeMigrationSql(sql);
  return storedChecksum === rawChecksum(canonical)
    || storedChecksum === rawChecksum(canonical.replace(/\n/g, "\r\n"));
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  migrationChecksum,
  migrationChecksumMatches,
  normalizeMigrationSql,
} from "@/lib/db/migration-checksum";

const LF_SQL = "CREATE TABLE example (id integer);\n-- next\nSELECT 1;\n";

describe("migration checksums", () => {
  it("uses one canonical checksum for Unix, Windows, and legacy Mac line endings", () => {
    expect(migrationChecksum(LF_SQL.replace(/\n/g, "\r\n"))).toBe(migrationChecksum(LF_SQL));
    expect(migrationChecksum(LF_SQL.replace(/\n/g, "\r"))).toBe(migrationChecksum(LF_SQL));
    expect(normalizeMigrationSql(LF_SQL.replace(/\n/g, "\r\n"))).toBe(LF_SQL);
  });

  it("accepts legacy LF and CRLF hashes without accepting changed SQL", () => {
    const legacyLf = createHash("sha256").update(LF_SQL).digest("hex");
    const legacyCrLf = createHash("sha256").update(LF_SQL.replace(/\n/g, "\r\n")).digest("hex");

    expect(migrationChecksumMatches(legacyLf, LF_SQL)).toBe(true);
    expect(migrationChecksumMatches(legacyCrLf, LF_SQL)).toBe(true);
    expect(migrationChecksumMatches(legacyLf, `${LF_SQL}SELECT 2;\n`)).toBe(false);
  });
});

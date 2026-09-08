import { describe, expect, it } from "vitest";
import { assertSyntheticSourceEnvironment, assertSyntheticSourceRequest } from "./e2e/source-preload-guard";

const database = "postgresql://synthetic:synthetic@127.0.0.1:55432/ahivim_e2e";
const valid = { DATABASE_URL: database, TEST_DATABASE_URL: database, E2E_EXPECTED_DB_HOST: "127.0.0.1",
  E2E_CONFIRM_RESET: "DROP_DISPOSABLE_E2E_DATABASE", AHIVIM_E2E_SOURCE_PRELOAD: "ALLOW_SYNTHETIC_SHEET_READ" };
const source = "https://docs.google.com/spreadsheets/d/1UtpmJE98pfMVWbbSNsn4ahPYvQUm9k5Kpfxj8nFGguk/export?format=csv&gid=1743235610";

describe("Synthetic browser source transport interlocks", () => {
  it("requires explicit matching disposable-database authorization before installing fetch transport", () => {
    expect(() => assertSyntheticSourceEnvironment(valid)).not.toThrow();
    for (const changed of [
      { AHIVIM_E2E_SOURCE_PRELOAD: undefined }, { E2E_CONFIRM_RESET: undefined },
      { E2E_EXPECTED_DB_HOST: "another-host.test" }, { TEST_DATABASE_URL: "" },
      { DATABASE_URL: "postgresql://synthetic:synthetic@another-host.test/neondb" },
    ]) expect(() => assertSyntheticSourceEnvironment({ ...valid, ...changed })).toThrow();
    const overrideUrl = `${database}?host=other-host.test&database=neondb`;
    expect(() => assertSyntheticSourceEnvironment({ ...valid, DATABASE_URL: overrideUrl, TEST_DATABASE_URL: overrideUrl })).toThrow();
  });

  it("permits only the pinned CSV GET and fails closed for writes or widened source reads", () => {
    expect(() => assertSyntheticSourceRequest(source, "GET")).not.toThrow();
    expect(() => assertSyntheticSourceRequest(source.replace("format=csv&gid=1743235610", "gid=1743235610&format=csv"), "GET")).not.toThrow();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => assertSyntheticSourceRequest(source, method)).toThrow();
    }
    for (const url of [source.replace("https:", "http:"), source.replace("docs.google.com", "other.test"),
      source.replace("format=csv", "format=xlsx"), source.replace("gid=1743235610", "gid=1"),
      `${source}&format=csv`, `${source}&range=A1`, `${source}#fragment`,
      source.replace("docs.google.com", "user:secret@docs.google.com"), source.replace("/export?", "/edit?"),
    ]) expect(() => assertSyntheticSourceRequest(url, "GET")).toThrow();
  });
});

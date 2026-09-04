import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/db/migrations.generated";
import { migrationChecksum } from "@/lib/db/migration-checksum";
import {
  PRODUCTION_RECOVERY_CONFIRMATION,
  PRODUCTION_RECOVERY_SCHEMA_MIGRATION,
  parseProductionRecoveryCliArgs,
  parseProductionRecoveryManifest,
  productionRecoveryConnectionString,
  productionRecoveryPassModes,
  redactProductionRecoveryError,
  requireProductionRecoverySchemaReady,
  verifyProductionRecoveryControlPlane,
} from "@/lib/import/production-recovery-cli";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const PROJECT = "quiet-project-123456";
const ENDPOINT = "ep-production-abc123";
const PRODUCTION_BRANCH = "br-production-main-abc123";
const BACKUP_BRANCH = "br-recovery-backup-abc123";
const HOST = `${ENDPOINT}.us-east-1.aws.neon.tech`;
const CONNECTION = `postgresql://recovery:password@${HOST}/neondb?sslmode=require`;
const NOW = Date.parse("2026-09-04T16:00:00Z");

const schemaMigration = MIGRATIONS.find(
  (migration) => migration.name === PRODUCTION_RECOVERY_SCHEMA_MIGRATION,
)!;

function schemaPool(row: {
  checksum: string | null;
  provenance_table: string | null;
  source_key_index: string | null;
}) {
  return {
    query: async () => ({ rows: [row] }),
  } as unknown as Parameters<typeof requireProductionRecoverySchemaReady>[0];
}

function controlPlaneFetch(input?: {
  backupStatus?: number;
  backupParentId?: string;
  backupInitSource?: string;
  backupCreatedAt?: string;
  productionDefault?: boolean;
}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = request.toString();
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.endsWith(`/endpoints/${ENDPOINT}`)) {
      return Response.json({
        endpoint: {
          id: ENDPOINT,
          host: HOST,
          project_id: PROJECT,
          branch_id: PRODUCTION_BRANCH,
          type: "read_write",
          disabled: false,
        },
      });
    }
    if (url.endsWith(`/branches/${PRODUCTION_BRANCH}`)) {
      return Response.json({
        branch: {
          id: PRODUCTION_BRANCH,
          project_id: PROJECT,
          current_state: "ready",
          default: input?.productionDefault ?? true,
          created_at: "2025-01-01T00:00:00Z",
        },
      });
    }
    if (url.endsWith(`/branches/${BACKUP_BRANCH}`)) {
      if (input?.backupStatus) {
        return Response.json(
          { internal: `Bearer api-secret ${CONNECTION}` },
          { status: input.backupStatus },
        );
      }
      return Response.json({
        branch: {
          id: BACKUP_BRANCH,
          project_id: PROJECT,
          parent_id: input?.backupParentId ?? PRODUCTION_BRANCH,
          current_state: "ready",
          default: false,
          init_source: input?.backupInitSource ?? "parent-data",
          created_at: input?.backupCreatedAt ?? "2026-09-04T15:30:00Z",
        },
      });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function validManifest(): unknown {
  return {
    version: 1,
    operations: [
      {
        kind: "individual-merge",
        mergeAuditLogId: "00000000-0000-4000-8000-000000000002",
        foldedId: "00000000-0000-4000-8000-000000000003",
        survivorId: "00000000-0000-4000-8000-000000000004",
        expectedFoldedName: "Sample, Miri",
        expectedSurvivorName: "Sample, Mira",
        evidenceSourceName: "Sample Miri",
        reason: "Restore two source-proven distinct people.",
      },
      { kind: "budget", file: "Budget.xlsx", asOfDate: "2026-09-04" },
      { kind: "calculations", file: "Calculations.xlsx", asOf: "2026-09-04" },
      { kind: "transactions", file: "Transactions.xlsx" },
    ],
  };
}

describe("production recovery CLI guard", () => {
  it("is a dry run by default", () => {
    expect(parseProductionRecoveryCliArgs(["--manifest", "recovery.json"])).toMatchObject({
      apply: false,
      actorId: null,
      confirmation: null,
      backupBranchId: null,
    });
  });

  it("authorizes apply only with the complete production proof", () => {
    expect(parseProductionRecoveryCliArgs([
      "--manifest", "recovery.json",
      "--apply",
      "--actor-id", ACTOR,
      "--backup-branch-id", "br-safe-copy-av123abc",
      "--confirm-production", PRODUCTION_RECOVERY_CONFIRMATION,
    ])).toMatchObject({
      apply: true,
      actorId: ACTOR,
      backupBranchId: "br-safe-copy-av123abc",
    });
  });

  it.each([
    {
      label: "actor",
      args: ["--manifest", "recovery.json", "--apply", "--backup-branch-id", "br-safe-copy-av123abc", "--confirm-production", PRODUCTION_RECOVERY_CONFIRMATION],
      error: "--actor-id",
    },
    {
      label: "exact confirmation",
      args: ["--manifest", "recovery.json", "--apply", "--actor-id", ACTOR, "--backup-branch-id", "br-safe-copy-av123abc", "--confirm-production", "apply-ahivim-production-recovery"],
      error: "must exactly equal",
    },
    {
      label: "Neon backup branch",
      args: ["--manifest", "recovery.json", "--apply", "--actor-id", ACTOR, "--confirm-production", PRODUCTION_RECOVERY_CONFIRMATION],
      error: "--backup-branch-id",
    },
  ])("rejects apply without $label", ({ args, error }) => {
    expect(() => parseProductionRecoveryCliArgs(args)).toThrow(error);
  });

  it("uses only the dedicated production recovery connection variable", () => {
    expect(() => productionRecoveryConnectionString({
      TEST_DATABASE_URL: "postgres://test.example/db",
      DATABASE_URL: "postgres://production.example/db",
    })).toThrow("PRODUCTION_RECOVERY_DATABASE_URL");
    expect(productionRecoveryConnectionString({
      PRODUCTION_RECOVERY_DATABASE_URL: ` ${CONNECTION} `,
      TEST_DATABASE_URL: "postgres://ignored.example/db",
    })).toBe(CONNECTION);
  });

  it.each([
    ["an arbitrary PostgreSQL host", "postgresql://role:password@db.example.com/neondb?sslmode=require", "direct Neon"],
    ["a pooled Neon host", `postgresql://role:password@${ENDPOINT}-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`, "not the pooled"],
    ["a Neon URL without an explicit TLS requirement", `postgresql://role:password@${HOST}/neondb`, "require TLS"],
  ])("rejects %s", (_label, connection, error) => {
    expect(() => productionRecoveryConnectionString({
      PRODUCTION_RECOVERY_DATABASE_URL: connection,
    })).toThrow(error);
  });

  it("does not accept disposable confirmation flags", () => {
    expect(() => parseProductionRecoveryCliArgs([
      "--manifest", "recovery.json",
      "--apply",
      "--confirm-disposable",
    ])).toThrow("Unknown production recovery option");
  });

  it("always schedules a complete dry-run pass before an apply pass", () => {
    expect(productionRecoveryPassModes(false)).toEqual(["dry-run"]);
    expect(productionRecoveryPassModes(true)).toEqual(["dry-run", "apply"]);
  });
});

describe("production recovery control-plane proof", () => {
  it("verifies the endpoint, production branch, and real backup parent chain", async () => {
    const { calls, fetchImpl } = controlPlaneFetch();
    await expect(verifyProductionRecoveryControlPlane({
      connectionString: CONNECTION,
      backupBranchId: BACKUP_BRANCH,
      environment: {
        PRODUCTION_RECOVERY_NEON_PROJECT_ID: PROJECT,
        PRODUCTION_RECOVERY_NEON_API_KEY: "api-secret",
        PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME: "neondb",
      },
      fetchImpl,
      nowMs: NOW,
    })).resolves.toEqual({
      projectId: PROJECT,
      endpointId: ENDPOINT,
      productionBranchId: PRODUCTION_BRANCH,
      databaseName: "neondb",
      backupBranchId: BACKUP_BRANCH,
      backupCreatedAt: "2026-09-04T15:30:00Z",
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.authorization === "Bearer api-secret")).toBe(true);
  });

  it("fails closed when the alleged backup does not exist", async () => {
    const { fetchImpl } = controlPlaneFetch({ backupStatus: 404 });
    await expect(verifyProductionRecoveryControlPlane({
      connectionString: CONNECTION,
      backupBranchId: BACKUP_BRANCH,
      environment: {
        PRODUCTION_RECOVERY_NEON_PROJECT_ID: PROJECT,
        PRODUCTION_RECOVERY_NEON_API_KEY: "api-secret",
        PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME: "neondb",
      },
      fetchImpl,
      nowMs: NOW,
    })).rejects.toThrow("HTTP 404");
  });

  it.each([
    ["the wrong parent", { backupParentId: "br-some-other-branch" }],
    ["schema without data", { backupInitSource: "parent-schema" }],
    ["a stale snapshot", { backupCreatedAt: "2026-09-02T15:30:00Z" }],
    ["a non-production destination", { productionDefault: false }],
  ])("rejects %s", async (_label, controlPlaneInput) => {
    const { fetchImpl } = controlPlaneFetch(controlPlaneInput);
    await expect(verifyProductionRecoveryControlPlane({
      connectionString: CONNECTION,
      backupBranchId: BACKUP_BRANCH,
      environment: {
        PRODUCTION_RECOVERY_NEON_PROJECT_ID: PROJECT,
        PRODUCTION_RECOVERY_NEON_API_KEY: "api-secret",
        PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME: "neondb",
      },
      fetchImpl,
      nowMs: NOW,
    })).rejects.toThrow();
  });

  it("requires dedicated control-plane credentials and redacts every secret", async () => {
    await expect(verifyProductionRecoveryControlPlane({
      connectionString: CONNECTION,
      backupBranchId: BACKUP_BRANCH,
      environment: {},
      fetchImpl: controlPlaneFetch().fetchImpl,
      nowMs: NOW,
    })).rejects.toThrow("PRODUCTION_RECOVERY_NEON_PROJECT_ID");

    await expect(verifyProductionRecoveryControlPlane({
      connectionString: CONNECTION.replace("/neondb?", "/wrong_database?"),
      backupBranchId: BACKUP_BRANCH,
      environment: {
        PRODUCTION_RECOVERY_NEON_PROJECT_ID: PROJECT,
        PRODUCTION_RECOVERY_NEON_API_KEY: "api-secret",
        PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME: "neondb",
      },
      fetchImpl: controlPlaneFetch().fetchImpl,
      nowMs: NOW,
    })).rejects.toThrow("does not match");

    const message = redactProductionRecoveryError(
      new Error(`failed ${CONNECTION} Bearer api-secret`),
      {
        PRODUCTION_RECOVERY_DATABASE_URL: CONNECTION,
        PRODUCTION_RECOVERY_NEON_API_KEY: "api-secret",
      },
    );
    expect(message).not.toContain(CONNECTION);
    expect(message).not.toContain("api-secret");
    expect(message).toContain("redacted");
  });
});

describe("production recovery runner ordering", () => {
  it("checks report paths and all artifacts before opening the database", async () => {
    const runner = await readFile("scripts/reconcile-production-recovery.ts", "utf8");
    expect(runner.indexOf("await requireSafeOutputPath")).toBeLessThan(runner.indexOf("new Pool"));
    expect(runner.indexOf("parseBudgetWorkbook(budgetBytes")).toBeLessThan(runner.indexOf("new Pool"));
    expect(runner.indexOf("await requireDatabaseIdentity")).toBeLessThan(
      runner.indexOf("for (const mode of productionRecoveryPassModes(options.apply))"),
    );
    expect(runner.indexOf("await requireProductionRecoverySchemaReady")).toBeLessThan(
      runner.indexOf("for (const mode of productionRecoveryPassModes(options.apply))"),
    );
    expect(runner).toContain("for (const mode of productionRecoveryPassModes(options.apply))");
    expect(runner).toContain('flag: "wx"');
  });
});

describe("production recovery schema readiness", () => {
  const ready = {
    checksum: migrationChecksum(schemaMigration.sql),
    provenance_table: "calculation_strategy_import_rows",
    source_key_index: "calculation_strategy_import_rows_source_key",
  };

  it("requires the recorded migration checksum and both physical relations", async () => {
    await expect(requireProductionRecoverySchemaReady(schemaPool(ready))).resolves.toBeUndefined();
  });

  it.each([
    ["missing migration ledger entry", { ...ready, checksum: null }],
    ["migration checksum drift", { ...ready, checksum: "wrong-checksum" }],
    ["missing provenance table", { ...ready, provenance_table: null }],
    ["missing source-key index", { ...ready, source_key_index: null }],
  ])("blocks %s", async (_label, row) => {
    await expect(requireProductionRecoverySchemaReady(schemaPool(row))).rejects.toThrow(
      /production recovery is blocked/i,
    );
  });
});

describe("production recovery manifest", () => {
  it("accepts the one fixed, dependency-safe operation order", () => {
    const manifest = parseProductionRecoveryManifest(validManifest());
    expect(manifest.operations.map((operation) => operation.kind)).toEqual([
      "individual-merge",
      "budget",
      "calculations",
      "transactions",
    ]);
  });

  it("rejects reordered or partial production recovery", () => {
    const reordered = validManifest() as { version: number; operations: unknown[] };
    [reordered.operations[0], reordered.operations[1]] = [reordered.operations[1], reordered.operations[0]];
    expect(() => parseProductionRecoveryManifest(reordered)).toThrow("must be ordered");
    expect(() => parseProductionRecoveryManifest({ version: 1, operations: [] })).toThrow("exactly four");
  });

  it("rejects malformed identity evidence and workbook inputs", () => {
    const samePeople = validManifest() as { operations: Array<Record<string, unknown>> };
    samePeople.operations[0]!.survivorId = samePeople.operations[0]!.foldedId;
    expect(() => parseProductionRecoveryManifest(samePeople)).toThrow("different people");

    const wrongFile = validManifest() as { operations: Array<Record<string, unknown>> };
    wrongFile.operations[1]!.file = "Budget.csv";
    expect(() => parseProductionRecoveryManifest(wrongFile)).toThrow(".xlsx");
  });
});

import { MIGRATIONS } from "@/lib/db/migrations.generated";
import { migrationChecksumMatches } from "@/lib/db/migration-checksum";
import type { PgLikePool } from "@/lib/import/commit";

export const PRODUCTION_RECOVERY_CONFIRMATION = "APPLY-AHIVIM-PRODUCTION-RECOVERY";
export const PRODUCTION_RECOVERY_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PRODUCTION_RECOVERY_SCHEMA_MIGRATION = "0041_calculation_workbook_provenance.sql";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEON_BRANCH_ID = /^br-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NEON_PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NEON_ENDPOINT_ID = /^ep-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECURE_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);
const NEON_API_ROOT = "https://console.neon.tech/api/v2";

export interface ProductionRecoveryCliOptions {
  manifest: string;
  out: string | null;
  apply: boolean;
  actorId: string | null;
  confirmation: string | null;
  backupBranchId: string | null;
  pretty: boolean;
  help: boolean;
}

export interface IndividualMergeRecoveryOperation {
  kind: "individual-merge";
  mergeAuditLogId: string;
  foldedId: string;
  survivorId: string;
  expectedFoldedName: string;
  expectedSurvivorName: string;
  evidenceSourceName: string;
  reason: string;
}

export interface BudgetRecoveryOperation {
  kind: "budget";
  file: string;
  asOfDate?: string;
}

export interface CalculationsRecoveryOperation {
  kind: "calculations";
  file: string;
  asOf?: string;
}

export interface TransactionsRecoveryOperation {
  kind: "transactions";
  file: string;
}

export type ProductionRecoveryOperation =
  | IndividualMergeRecoveryOperation
  | BudgetRecoveryOperation
  | CalculationsRecoveryOperation
  | TransactionsRecoveryOperation;

export interface ProductionRecoveryManifest {
  version: 1;
  operations: [
    IndividualMergeRecoveryOperation,
    BudgetRecoveryOperation,
    CalculationsRecoveryOperation,
    TransactionsRecoveryOperation,
  ];
}

type ConnectionEnvironment = Record<string, string | undefined>;

export interface ProductionRecoveryControlPlaneProof {
  projectId: string;
  endpointId: string;
  productionBranchId: string;
  databaseName: string;
  backupBranchId: string;
  backupCreatedAt: string;
}

interface NeonControlPlaneConfig {
  apiKey: string;
  projectId: string;
  expectedDatabaseName: string;
}

interface NeonEndpoint {
  id: string;
  host: string;
  project_id: string;
  branch_id: string;
  type: string;
  disabled: boolean;
}

interface NeonBranch {
  id: string;
  project_id: string;
  parent_id?: string;
  current_state: string;
  default: boolean;
  init_source?: string;
  created_at: string;
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Production recovery manifest field ${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalDate(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isRealIsoDate(value)) {
    throw new Error(`Production recovery manifest field ${key} must be a real YYYY-MM-DD date.`);
  }
  return value;
}

function operationRecord(value: unknown, expectedKind: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Production recovery operation ${expectedKind} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== expectedKind) {
    throw new Error(
      `Production recovery operations must be ordered: individual-merge, budget, calculations, transactions. Expected ${expectedKind}.`,
    );
  }
  return record;
}

function workbookPath(record: Record<string, unknown>): string {
  const file = requireString(record, "file");
  if (!file.toLowerCase().endsWith(".xlsx")) {
    throw new Error("Production recovery workbook paths must end in .xlsx.");
  }
  return file;
}

export function productionRecoveryCliUsage(): string {
  return [
    "Usage: node --import tsx scripts/reconcile-production-recovery.ts --manifest <recovery.json> [options]",
    "",
    "Options:",
    "  --out <report.json>             Also save the machine-readable report.",
    "  --pretty                        Pretty-print JSON output.",
    "  --apply                         Run the guarded production writes; default is dry-run.",
    "  --actor-id <uuid>               Required with --apply; identifies the operator.",
    "  --backup-branch-id <br-...>     Required with --apply; the pre-created Neon backup branch.",
    `  --confirm-production <token>    Required with --apply; exact token is ${PRODUCTION_RECOVERY_CONFIRMATION}.`,
    "  --help                          Show this help.",
    "",
    "This command reads its database connection only from PRODUCTION_RECOVERY_DATABASE_URL.",
    "Apply also verifies the target and backup through PRODUCTION_RECOVERY_NEON_PROJECT_ID",
    "PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME, and PRODUCTION_RECOVERY_NEON_API_KEY",
    "before opening the database.",
    "The disposable recovery commands remain separate and continue to accept only TEST_DATABASE_URL.",
  ].join("\n");
}

export function parseProductionRecoveryCliArgs(args: string[]): ProductionRecoveryCliOptions {
  const options: ProductionRecoveryCliOptions = {
    manifest: "",
    out: null,
    apply: false,
    actorId: null,
    confirmation: null,
    backupBranchId: null,
    pretty: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help") options.help = true;
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--pretty") options.pretty = true;
    else if (argument === "--manifest") options.manifest = nextValue(args, index++, argument);
    else if (argument === "--out") options.out = nextValue(args, index++, argument);
    else if (argument === "--actor-id") options.actorId = nextValue(args, index++, argument);
    else if (argument === "--backup-branch-id") options.backupBranchId = nextValue(args, index++, argument);
    else if (argument === "--confirm-production") options.confirmation = nextValue(args, index++, argument);
    else throw new Error(`Unknown production recovery option: ${argument}`);
  }

  if (options.help) return options;
  if (!options.manifest.trim()) throw new Error("--manifest is required.");
  if (!options.apply) return options;
  if (!options.actorId) throw new Error("--apply requires --actor-id.");
  if (!UUID.test(options.actorId)) throw new Error("--actor-id must be a UUID.");
  if (options.confirmation !== PRODUCTION_RECOVERY_CONFIRMATION) {
    throw new Error(
      `--confirm-production must exactly equal ${PRODUCTION_RECOVERY_CONFIRMATION}.`,
    );
  }
  if (!options.backupBranchId) throw new Error("--apply requires --backup-branch-id.");
  if (!NEON_BRANCH_ID.test(options.backupBranchId)) {
    throw new Error("--backup-branch-id must be a Neon branch ID beginning with br-.");
  }
  return options;
}

/**
 * Production recovery has its own connection namespace. Deliberately do not
 * fall back to DATABASE_URL, TEST_DATABASE_URL, or any Vercel/Postgres alias.
 */
export function productionRecoveryConnectionString(
  environment: ConnectionEnvironment = process.env,
): string {
  const value = environment.PRODUCTION_RECOVERY_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "Set PRODUCTION_RECOVERY_DATABASE_URL explicitly. No other database variable is accepted by production recovery.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PRODUCTION_RECOVERY_DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PRODUCTION_RECOVERY_DATABASE_URL must use postgres:// or postgresql://.");
  }
  const hostLabel = parsed.hostname.toLowerCase().split(".")[0] ?? "";
  if (!parsed.hostname.toLowerCase().endsWith(".neon.tech") || !NEON_ENDPOINT_ID.test(hostLabel)) {
    throw new Error("PRODUCTION_RECOVERY_DATABASE_URL must target a direct Neon compute endpoint.");
  }
  if (hostLabel.endsWith("-pooler")) {
    throw new Error("PRODUCTION_RECOVERY_DATABASE_URL must use the direct endpoint, not the pooled endpoint.");
  }
  if (parsed.port && parsed.port !== "5432") {
    throw new Error("PRODUCTION_RECOVERY_DATABASE_URL must use the standard PostgreSQL port.");
  }
  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase() ?? "";
  if (!SECURE_SSL_MODES.has(sslMode)) {
    throw new Error("PRODUCTION_RECOVERY_DATABASE_URL must explicitly require TLS with sslmode.");
  }
  if (!parsed.username || parsed.pathname === "/" || !parsed.pathname) {
    throw new Error("PRODUCTION_RECOVERY_DATABASE_URL must identify both a database role and database.");
  }
  return value;
}

function productionRecoveryControlPlaneConfig(
  environment: ConnectionEnvironment,
): NeonControlPlaneConfig {
  const projectId = environment.PRODUCTION_RECOVERY_NEON_PROJECT_ID?.trim() ?? "";
  const apiKey = environment.PRODUCTION_RECOVERY_NEON_API_KEY?.trim() ?? "";
  const expectedDatabaseName = environment.PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME?.trim() ?? "";
  if (!projectId || !NEON_PROJECT_ID.test(projectId)) {
    throw new Error(
      "Apply requires a valid PRODUCTION_RECOVERY_NEON_PROJECT_ID for control-plane verification.",
    );
  }
  if (!apiKey) {
    throw new Error(
      "Apply requires PRODUCTION_RECOVERY_NEON_API_KEY for control-plane verification.",
    );
  }
  if (!expectedDatabaseName || expectedDatabaseName.length > 63 || expectedDatabaseName.includes("\0")) {
    throw new Error(
      "Apply requires a valid PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME.",
    );
  }
  return { apiKey, projectId, expectedDatabaseName };
}

function objectField(value: unknown, field: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Neon returned invalid ${label} verification data.`);
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  if (!fieldValue || typeof fieldValue !== "object" || Array.isArray(fieldValue)) {
    throw new Error(`Neon returned invalid ${label} verification data.`);
  }
  return fieldValue as Record<string, unknown>;
}

function endpointFrom(value: unknown): NeonEndpoint {
  const endpoint = objectField(value, "endpoint", "endpoint");
  if (
    typeof endpoint.id !== "string"
    || typeof endpoint.host !== "string"
    || typeof endpoint.project_id !== "string"
    || typeof endpoint.branch_id !== "string"
    || typeof endpoint.type !== "string"
    || typeof endpoint.disabled !== "boolean"
  ) {
    throw new Error("Neon returned invalid endpoint verification data.");
  }
  return endpoint as unknown as NeonEndpoint;
}

function branchFrom(value: unknown, label: string): NeonBranch {
  const branch = objectField(value, "branch", label);
  if (
    typeof branch.id !== "string"
    || typeof branch.project_id !== "string"
    || typeof branch.current_state !== "string"
    || typeof branch.default !== "boolean"
    || typeof branch.created_at !== "string"
    || (branch.parent_id !== undefined && typeof branch.parent_id !== "string")
    || (branch.init_source !== undefined && typeof branch.init_source !== "string")
  ) {
    throw new Error(`Neon returned invalid ${label} verification data.`);
  }
  return branch as unknown as NeonBranch;
}

async function neonControlPlaneGet(
  path: string,
  apiKey: string,
  label: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${NEON_API_ROOT}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Neon could not verify the ${label}; production apply is blocked.`);
  }
  if (!response.ok) {
    throw new Error(
      `Neon could not verify the ${label} (HTTP ${response.status}); production apply is blocked.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Neon returned invalid ${label} verification data.`);
  }
}

/**
 * Prove through Neon's read-only control plane that the connection host is the
 * default read-write branch and that the supplied backup is a recent, ready,
 * data-bearing child of that exact branch. Merely resembling a br-* ID is not
 * sufficient to unlock production writes.
 */
export async function verifyProductionRecoveryControlPlane(
  input: {
    connectionString: string;
    backupBranchId: string;
    environment?: ConnectionEnvironment;
    fetchImpl?: typeof fetch;
    nowMs?: number;
  },
): Promise<ProductionRecoveryControlPlaneProof> {
  if (!NEON_BRANCH_ID.test(input.backupBranchId)) {
    throw new Error("The backup branch ID is not a valid Neon branch ID.");
  }
  const { apiKey, projectId, expectedDatabaseName } = productionRecoveryControlPlaneConfig(
    input.environment ?? process.env,
  );
  const connection = new URL(input.connectionString);
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(connection.pathname.slice(1));
  } catch {
    throw new Error("The production connection contains an invalid database name.");
  }
  if (databaseName !== expectedDatabaseName) {
    throw new Error(
      "The production connection database does not match PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME.",
    );
  }
  const targetHost = connection.hostname.toLowerCase();
  const endpointId = targetHost.split(".")[0] ?? "";
  if (!NEON_ENDPOINT_ID.test(endpointId) || endpointId.endsWith("-pooler")) {
    throw new Error("The production connection does not identify a direct Neon endpoint.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const encodedProjectId = encodeURIComponent(projectId);
  const endpoint = endpointFrom(await neonControlPlaneGet(
    `/projects/${encodedProjectId}/endpoints/${encodeURIComponent(endpointId)}`,
    apiKey,
    "production endpoint",
    fetchImpl,
  ));
  if (
    endpoint.id !== endpointId
    || endpoint.project_id !== projectId
    || endpoint.host.toLowerCase() !== targetHost
    || endpoint.type !== "read_write"
    || endpoint.disabled
  ) {
    throw new Error(
      "The Neon endpoint does not exactly match an enabled read-write endpoint in the configured project.",
    );
  }

  const productionBranch = branchFrom(await neonControlPlaneGet(
    `/projects/${encodedProjectId}/branches/${encodeURIComponent(endpoint.branch_id)}`,
    apiKey,
    "production branch",
    fetchImpl,
  ), "production branch");
  if (
    productionBranch.id !== endpoint.branch_id
    || productionBranch.project_id !== projectId
    || productionBranch.default !== true
    || productionBranch.current_state !== "ready"
  ) {
    throw new Error(
      "The database endpoint is not attached to the ready default branch of the configured Neon project.",
    );
  }

  const backupBranch = branchFrom(await neonControlPlaneGet(
    `/projects/${encodedProjectId}/branches/${encodeURIComponent(input.backupBranchId)}`,
    apiKey,
    "backup branch",
    fetchImpl,
  ), "backup branch");
  const backupCreatedMs = Date.parse(backupBranch.created_at);
  const ageMs = (input.nowMs ?? Date.now()) - backupCreatedMs;
  if (
    backupBranch.id !== input.backupBranchId
    || backupBranch.project_id !== projectId
    || backupBranch.parent_id !== productionBranch.id
    || backupBranch.default
    || backupBranch.current_state !== "ready"
    || backupBranch.init_source !== "parent-data"
    || !Number.isFinite(backupCreatedMs)
    || ageMs < -5 * 60 * 1_000
    || ageMs > PRODUCTION_RECOVERY_BACKUP_MAX_AGE_MS
  ) {
    throw new Error(
      "The backup is not a recent, ready, data-bearing child of the exact production branch; apply is blocked.",
    );
  }

  return {
    projectId,
    endpointId,
    productionBranchId: productionBranch.id,
    databaseName,
    backupBranchId: backupBranch.id,
    backupCreatedAt: backupBranch.created_at,
  };
}

export function productionRecoveryPassModes(
  apply: boolean,
): readonly ("dry-run" | "apply")[] {
  return apply ? ["dry-run", "apply"] : ["dry-run"];
}

/**
 * Fail closed before any recovery service is called. The Calculations dry run
 * does not write provenance, so it cannot by itself prove that apply mode has
 * the migration and unique source-key index it needs.
 */
export async function requireProductionRecoverySchemaReady(
  pool: Pick<PgLikePool, "query">,
): Promise<void> {
  const migration = MIGRATIONS.find((candidate) => candidate.name === PRODUCTION_RECOVERY_SCHEMA_MIGRATION);
  if (!migration) {
    throw new Error(
      `This build does not embed required migration ${PRODUCTION_RECOVERY_SCHEMA_MIGRATION}; production recovery is blocked.`,
    );
  }

  const { rows } = await pool.query<{
    checksum: string | null;
    provenance_table: string | null;
    source_key_index: string | null;
  }>(
    `SELECT
       (SELECT checksum
          FROM _ahivim_migrations
         WHERE name = $1) AS checksum,
       to_regclass(current_schema() || '.calculation_strategy_import_rows')::text
         AS provenance_table,
       to_regclass(current_schema() || '.calculation_strategy_import_rows_source_key')::text
         AS source_key_index`,
    [PRODUCTION_RECOVERY_SCHEMA_MIGRATION],
  );
  const readiness = rows[0];
  if (!readiness?.checksum) {
    throw new Error(
      `Required migration ${PRODUCTION_RECOVERY_SCHEMA_MIGRATION} is not recorded; production recovery is blocked.`,
    );
  }
  if (!migrationChecksumMatches(readiness.checksum, migration.sql)) {
    throw new Error(
      `Required migration ${PRODUCTION_RECOVERY_SCHEMA_MIGRATION} has a checksum mismatch; production recovery is blocked.`,
    );
  }
  if (!readiness.provenance_table || !readiness.source_key_index) {
    throw new Error(
      "Calculation workbook provenance table or source-key index is missing; production recovery is blocked.",
    );
  }
}

/** Keep database URLs, API credentials, and bearer tokens out of terminal JSON. */
export function redactProductionRecoveryError(
  error: unknown,
  environment: ConnectionEnvironment = process.env,
): string {
  let message = error instanceof Error ? error.message : "Production recovery failed.";
  const secrets = [
    environment.PRODUCTION_RECOVERY_DATABASE_URL,
    environment.PRODUCTION_RECOVERY_NEON_API_KEY,
  ];
  try {
    const connection = new URL(environment.PRODUCTION_RECOVERY_DATABASE_URL ?? "");
    secrets.push(connection.hostname, connection.password ? decodeURIComponent(connection.password) : undefined);
  } catch {
    // A malformed URL is still removed in full by the first secret replacement.
  }
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[secret redacted]");
  }
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[connection string redacted]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [secret redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+:[^@\s/]+@[A-Za-z0-9.-]+/g, "[credentials redacted]")
    .slice(0, 500);
}

export function parseProductionRecoveryManifest(value: unknown): ProductionRecoveryManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Production recovery manifest must be a JSON object.");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1) throw new Error("Production recovery manifest version must be 1.");
  if (!Array.isArray(manifest.operations) || manifest.operations.length !== 4) {
    throw new Error("Production recovery manifest must contain exactly four operations.");
  }

  const merge = operationRecord(manifest.operations[0], "individual-merge");
  const budget = operationRecord(manifest.operations[1], "budget");
  const calculations = operationRecord(manifest.operations[2], "calculations");
  const transactions = operationRecord(manifest.operations[3], "transactions");

  const mergeAuditLogId = requireString(merge, "mergeAuditLogId");
  const foldedId = requireString(merge, "foldedId");
  const survivorId = requireString(merge, "survivorId");
  for (const [key, id] of Object.entries({ mergeAuditLogId, foldedId, survivorId })) {
    if (!UUID.test(id)) throw new Error(`Production recovery manifest field ${key} must be a UUID.`);
  }
  if (foldedId === survivorId) {
    throw new Error("Production recovery foldedId and survivorId must identify different people.");
  }

  return {
    version: 1,
    operations: [
      {
        kind: "individual-merge",
        mergeAuditLogId,
        foldedId,
        survivorId,
        expectedFoldedName: requireString(merge, "expectedFoldedName"),
        expectedSurvivorName: requireString(merge, "expectedSurvivorName"),
        evidenceSourceName: requireString(merge, "evidenceSourceName"),
        reason: requireString(merge, "reason"),
      },
      {
        kind: "budget",
        file: workbookPath(budget),
        ...(optionalDate(budget, "asOfDate") ? { asOfDate: optionalDate(budget, "asOfDate") } : {}),
      },
      {
        kind: "calculations",
        file: workbookPath(calculations),
        ...(optionalDate(calculations, "asOf") ? { asOf: optionalDate(calculations, "asOf") } : {}),
      },
      { kind: "transactions", file: workbookPath(transactions) },
    ],
  };
}

# Production recovery runner

The takeover recoveries have one production-only entry point. It restores the
proven incorrect individual merge first, then reconciles Budget, Calculations,
and Transactions in that dependency-safe order. The command is a dry run unless
`--apply` is present.

The existing disposable-branch commands are unchanged. They still write only
through `TEST_DATABASE_URL` plus `--confirm-disposable`; those flags and that
connection variable are deliberately not accepted by this runner.

## Manifest

Create a JSON file whose workbook paths are absolute or relative to the manifest:

```json
{
  "version": 1,
  "operations": [
    {
      "kind": "individual-merge",
      "mergeAuditLogId": "<merge-audit-uuid>",
      "foldedId": "<individual-to-restore-uuid>",
      "survivorId": "<incorrect-survivor-uuid>",
      "expectedFoldedName": "<exact-current-name>",
      "expectedSurvivorName": "<exact-current-name>",
      "evidenceSourceName": "<exact-source-spelling>",
      "reason": "<specific-audit-reason>"
    },
    {
      "kind": "budget",
      "file": "Budget copy.xlsx",
      "asOfDate": "2026-09-04"
    },
    {
      "kind": "calculations",
      "file": "Ahivim Calculations copy.xlsx",
      "asOf": "2026-09-04"
    },
    {
      "kind": "transactions",
      "file": "live-transaction-feed.xlsx"
    }
  ]
}
```

The runner requires exactly these four operations and this order. All three
workbooks are loaded and parsed before a database connection is opened.

## Backup and schema prerequisite

Immediately before changing production, create a Neon branch from the production
branch with schema **and data**, wait until it is `ready`, and retain its immutable
`br-...` ID. Then apply and verify migration
`0041_calculation_workbook_provenance.sql` before running even the recovery preview.
The runner fails closed unless `_ahivim_migrations` contains the exact migration
checksum and both the provenance table and its unique source-key index exist.

## Preview

Set the dedicated variable to the direct production Neon connection URL. The
runner never falls back to `DATABASE_URL`, `TEST_DATABASE_URL`, or Vercel's
Postgres aliases. The URL must name a direct (not pooled) Neon endpoint and
must explicitly require TLS with `sslmode=require` (or a stronger mode).

```powershell
$env:PRODUCTION_RECOVERY_DATABASE_URL = '<direct-production-neon-url>'
node --import tsx scripts/reconcile-production-recovery.ts `
  --manifest '<recovery-manifest.json>' `
  --out '<dry-run-report.json>' `
  --pretty
```

Review the dry-run report before apply. In particular, the merge correction
must say `ready`; workbook rows marked ambiguous, different, repeated, or
historical remain review evidence and are not overwritten or deleted.

## Apply

Use the backup branch created immediately before migration and do not use a
branch older than 24 hours.

Create or obtain a Neon API key that can read this project. Put it in the
dedicated environment variable, never in a command argument, manifest, report,
shell history, or chat. The runner uses only read-only Neon API calls. It verifies
that the connection host is the configured project's enabled read-write endpoint,
that the endpoint belongs to the ready default branch, that both the connection
URL and live server report the explicitly named production database and `public`
schema, and that the supplied backup really exists as a recent `parent-data`
child of that exact branch.

```powershell
$env:PRODUCTION_RECOVERY_NEON_PROJECT_ID = '<neon-project-id>'
$env:PRODUCTION_RECOVERY_EXPECTED_DATABASE_NAME = '<production-database-name>'
$env:PRODUCTION_RECOVERY_NEON_API_KEY = '<neon-api-key>'
```

```powershell
node --import tsx scripts/reconcile-production-recovery.ts `
  --manifest '<recovery-manifest.json>' `
  --out '<apply-report.json>' `
  --pretty `
  --apply `
  --actor-id '<active-production-user-uuid>' `
  --backup-branch-id '<br-neon-backup-id>' `
  --confirm-production 'APPLY-AHIVIM-PRODUCTION-RECOVERY'
```

Apply cannot begin until the actor UUID is syntactically valid and resolves to
one active production user, the confirmation phrase matches exactly, and the
database destination and backup pass the control-plane checks above. The actor
is passed through to all four services for their existing audit records.

Before any reconciliation service is called, the runner verifies the required
migration ledger checksum, provenance table, and source-key index. Before the
first write, it then executes all four reconciliations in dry-run mode against
the verified destination. This catches query failures, blocked merge evidence,
and invalid workbook layouts before any service can commit. It then applies the
same fixed order: individual merge, Budget, Calculations, Transactions.

Each service keeps its own transaction and idempotency rules. If a later
operation fails, correct the cause and rerun the same manifest; completed
operations reconcile as no-ops. Report paths are append-only safeguards: `--out`
must be a new path and can never replace the manifest, a workbook, or a prior
report. Run the same apply command a second time with a **different** report path
as the final idempotency check, then compare both reports and verify the
application and production logs.

After both runs, remove the API credential from the process environment and
revoke a short-lived key if one was created for this recovery:

```powershell
Remove-Item Env:PRODUCTION_RECOVERY_NEON_API_KEY
```

# Deployment

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon connection string. `POSTGRES_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL` and `NEON_DATABASE_URL` are accepted as fallbacks, in that order. |
| `AUTH_SECRET` | recommended | Signs session cookies. If unset, a key is derived from the database connection string with HKDF-SHA256 (see `docs/authentication.md`). |
| `BOOTSTRAP_ADMIN_EMAIL` | first deploy only | Email of the first administrator. |
| `BOOTSTRAP_ADMIN_PASSWORD` | first deploy only | Password of the first administrator, minimum 10 characters. |
| `MIGRATION_TOKEN` | optional | Allows `POST /api/admin/migrate` and the one-time `POST /api/sync/bootstrap` without a signed-in administrator. Needed only for a database that has no administrator yet, or for automated deploys. |
| `CRON_SECRET` | scheduled sync | Authenticates Vercel Cron calls to `/api/sync/cron`. Use a separate random secret; the route fails closed when it is absent, though a signed-in administrator may still trigger it manually. |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL` | private Sheet sync | Service-account email allowed to view the configured sheet and edit its Paid column. |
| `GOOGLE_SHEETS_PRIVATE_KEY` | private Sheet sync | Private key for that service account. Escaped `\n` line breaks are accepted. |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | private Sheet sync alternative | Raw or base64-encoded service-account JSON. Use this instead of the two fields above. |
| `MAX_UPLOAD_BYTES` | optional | Upload ceiling in bytes. Defaults to 20 MiB. |
| `BLOB_READ_WRITE_TOKEN` | PDF library | Private Vercel Blob store token. Connect a Blob store to the Vercel project so original and edited PDFs remain private. |
| `MAX_PDF_UPLOAD_BYTES` | optional | Direct PDF upload ceiling in bytes. Defaults to 100 MiB and is capped at 500 MiB. |
| `NEON_WS_PROXY` | local dev only | `host:port` of a WebSocket-to-TCP bridge, so the Neon driver can reach a local PostgreSQL. Never set in production. |

The `Sync Google Sheet` button always pulls the latest source information. With
service-account credentials, both the read and Paid-marker write-back use the
authenticated Sheets API, so the Sheet can remain private. The app sends only
payment-marker changes from tracked transactions to the Paid column. It does
not edit amounts, rates, formulas, names, dates, or any other source cells.
Share the Sheet with the service-account email as an editor. Without service account
credentials, the app can only use the legacy public-link CSV pull and
cannot write.

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Health checks

The health endpoints are read-only and callable without a session. Anonymous
responses contain only aggregate readiness; signed-in administrators receive
the detailed diagnostics where applicable. No endpoint returns a secret value.

- `GET /api/health/env` — anonymous callers receive one configuration-readiness
  boolean. Administrators can see which variables are **present**, never their
  values, including whether private document storage is configured.
- `GET /api/health/db` — anonymous callers receive connectivity and migration
  health. Latency, server time, connection-variable name, table names and row
  counts are returned only to a signed-in administrator.
- `GET /api/health/schema` — compares the migration ledger to the migrations in
  the deployed build without applying anything. Anonymous callers receive only
  `healthy`; administrators can inspect the table and migration inventory.
- `GET /api/health/xlsx` — loads ExcelJS and round-trips a workbook (write then
  read) in the deployed runtime. Confirms the upload engine works without an
  authenticated upload; returns `{ok:true}` or, on a require-of-ESM regression,
  `{ok:false, code:"ERR_REQUIRE_ESM"}`. See the dependency note below.

Health GETs never run migrations, post-migration data tasks, sheet syncs, or
other database writes.

## Migrations

The runner is idempotent. Each file in `drizzle/` runs once, inside its own
transaction, and is recorded in `_ahivim_migrations` with a SHA-256 checksum.
Re-running skips everything already applied. Editing a migration that has
already been applied fails migration and health checks immediately rather than
silently accepting a changed checksum. Add a new migration instead.

Production also calls the runner from the Node instrumentation hook. The normal
current-schema path is one lock-free checksum query. When a deployment is
behind, one instance takes a nonblocking advisory lock and applies the pending
migrations; other cold starts continue instead of waiting on that lock. Set
`DISABLE_AUTO_MIGRATE=1` only when migrations are deliberately managed outside
the application.

The same runner can be invoked manually in three ways:

```bash
# 1. Directly, from a machine that can reach the database
DATABASE_URL=... npm run db:migrate

# 2. As a signed-in administrator
curl -X POST https://<host>/api/admin/migrate -b "ahivim_session=<cookie>"

# 3. With a dedicated secret, for a database that has no administrator yet
curl -X POST https://<host>/api/admin/migrate -H "x-migration-token: $MIGRATION_TOKEN"
```

There is **no** unauthenticated migration path. An earlier revision allowed one
"first run" call while the ledger table did not exist; on a publicly reachable
deployment that is a race anyone can win, so it was removed.

The one-time Sheet bootstrap is also explicit and fail-closed. Use a signed-in
administrator or the first-deploy token:

```bash
curl -X POST https://<host>/api/sync/bootstrap -H "x-migration-token: $MIGRATION_TOKEN"
```

`GET /api/sync/bootstrap` is not a mutation endpoint and returns method not
allowed. `/api/sync/cron` accepts the Vercel Cron bearer secret or a signed-in
administrator; an absent `CRON_SECRET` never opens the route anonymously.

The instrumentation hook applies schema migrations only. It never creates an
account, generates a password, or prints credentials. Administrator bootstrap
remains confined to the explicit first sign-in flow below.

## First administrator

Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`, then sign in with
exactly those credentials. The account is created on that first successful
sign-in and only while the `users` table is empty. After that the window is
closed permanently and further accounts are created by an administrator in
Settings. There is no public sign-up, and no password is ever generated,
logged, or returned in a response.

## Build

`vercel.json` pins the framework to `nextjs` and the build command to
`npm run build`, so the deployment is reproducible from the repository rather
than from dashboard state. `npm run build` runs `prebuild`, which embeds the
SQL migration files into `src/lib/db/migrations.generated.ts`; running
`next build` directly would skip that step.

## Running against a local PostgreSQL

The Neon driver speaks the Postgres wire protocol over a WebSocket and cannot
open a socket to a local server. `scripts/ws-proxy.ts` bridges the two, which
lets the real build run against a local database:

```bash
createdb ahivim_dev
npm run dev:ws-proxy          # listens on 5480

DATABASE_URL=postgres://postgres@127.0.0.1:5432/ahivim_dev \
NEON_WS_PROXY=127.0.0.1:5480 npm run db:migrate

DATABASE_URL=postgres://postgres@127.0.0.1:5432/ahivim_dev \
NEON_WS_PROXY=127.0.0.1:5480 \
AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
BOOTSTRAP_ADMIN_EMAIL=you@example.com BOOTSTRAP_ADMIN_PASSWORD=a-long-password \
npm run dev
```

`NEON_WS_PROXY` is unset in production, where `src/lib/db/index.ts` ignores it.

### Playwright disposable-database reset interlock

The end-to-end seed drops and recreates the target `public` schema. Run it only
against a dedicated disposable database. The reset fails closed unless all
three variables below are set explicitly; it never falls back to
`DATABASE_URL`:

```powershell
$env:TEST_DATABASE_URL = '<disposable-postgres-url>'
$env:E2E_EXPECTED_DB_HOST = '<hostname-from-that-url>'
$env:E2E_CONFIRM_RESET = 'DROP_DISPOSABLE_E2E_DATABASE'
npm run e2e
```

`E2E_EXPECTED_DB_HOST` must exactly match the hostname parsed from
`TEST_DATABASE_URL`, and the URL must use the `postgres` or `postgresql`
protocol and name a database. Never set these reset controls to a production
database or production host.

## ExcelJS and the CommonJS dependency chain

ExcelJS is loaded in the Node server runtime with CommonJS `require`, and it
`require`s `uuid` and `archiver`. A previous override forced that dependency
chain onto incompatible ESM-only majors, causing `ERR_REQUIRE_ESM` in the
serverless runtime and taking down `/api/imports` even though the build passed.

`package.json` now pins `nanoid` to `3.3.18` and, specifically within ExcelJS,
pins `uuid` to `11.1.1`. That `uuid` release provides an explicit CommonJS
`require` export while retaining the security fixes represented by the current
lockfile. `tests/exceljs-cjs-runtime.test.ts` guards the runtime contract by
loading ExcelJS, resolving its `uuid` and `archiver` dependencies, and parsing
a real workbook under `node --no-experimental-require-module`.

The locked dependency tree currently reports zero vulnerabilities from both
the full `npm audit` and the production/runtime `npm audit --omit=dev` check.

# Deployment

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon connection string. `POSTGRES_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL` and `NEON_DATABASE_URL` are accepted as fallbacks, in that order. |
| `AUTH_SECRET` | recommended | Signs session cookies. If unset, a key is derived from the database connection string with HKDF-SHA256 (see `docs/authentication.md`). |
| `BOOTSTRAP_ADMIN_EMAIL` | first deploy only | Email of the first administrator. |
| `BOOTSTRAP_ADMIN_PASSWORD` | first deploy only | Password of the first administrator, minimum 10 characters. |
| `MIGRATION_TOKEN` | optional | Allows `POST /api/admin/migrate` without a signed-in administrator. Needed only for a database that has no administrator yet, or for automated deploys. |
| `MAX_UPLOAD_BYTES` | optional | Upload ceiling in bytes. Defaults to 20 MiB. |
| `NEON_WS_PROXY` | local dev only | `host:port` of a WebSocket-to-TCP bridge, so the Neon driver can reach a local PostgreSQL. Never set in production. |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Health checks

Neither endpoint returns a secret value; both are readable without a session so
a deployment check can call them.

- `GET /api/health/env` — which variables are **present**, never their values.
- `GET /api/health/db` — live connectivity, latency, whether migrations are
  applied, and the table count. The table NAMES and per-table ROW COUNTS are a
  map of the schema and of how much data sits in each part of it, so they are
  returned only to a signed-in administrator.
- `GET /api/health/xlsx` — loads ExcelJS and round-trips a workbook (write then
  read) in the deployed runtime. Confirms the upload engine works without an
  authenticated upload; returns `{ok:true}` or, on a require-of-ESM regression,
  `{ok:false, code:"ERR_REQUIRE_ESM"}`. See the dependency note below.

## Migrations

The runner is idempotent. Each file in `drizzle/` runs once, inside its own
transaction, and is recorded in `_ahivim_migrations` with a SHA-256 checksum.
Re-running skips everything already applied. Editing a migration that has
already been applied is reported as `checksum_mismatch` rather than silently
ignored — add a new migration instead.

Three ways to apply them:

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

There is also no start-up bootstrap hook. `src/instrumentation.ts` used to
apply migrations and create an administrator on the first request, printing a
generated password to the runtime log. It was removed because it ran sensitive
initialisation from an uncontrolled trigger, printed a credential to a log, and
forced Node-only crypto into the Edge bundle (which produced a build full of
misleading `'timingSafeEqual' is not exported from 'node:crypto'` warnings).

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

## ExcelJS and the CommonJS dependency chain

ExcelJS is loaded in the Node server runtime with CommonJS `require`, and it
`require`s `uuid` and `archiver`. Both of those, and much of ExcelJS's
transitive chain (`glob`, `minimatch`, `brace-expansion`, `zip-stream`,
`readdir-glob`), have released newer **ESM-only** majors. Forcing ExcelJS onto
any of them makes its `require` throw `ERR_REQUIRE_ESM` in the serverless
runtime and takes down `/api/imports` — even though the build succeeds and it
works locally, because Node >= 22 allows `require()` of an ES module by default
and the Vercel runtime does not.

`package.json` therefore pins, via `overrides`, ExcelJS's `uuid` to `10.0.0`
(the newest CommonJS uuid) and does **not** force the rest of the chain onto
ESM-only versions. `tests/exceljs-cjs-runtime.test.ts` guards this: it loads and
parses a workbook under `node --no-experimental-require-module`, so any future
ESM-only pin fails the test instead of production.

The cost is that `npm audit` reports advisories in ExcelJS's chain that have no
CommonJS-compatible fix (npm's only suggested fix is a major downgrade to
`exceljs@3.4.0`). These are **DoS/ReDoS**-class issues (no RCE, no data
exposure) reached only when parsing an uploaded `.xlsx`, and upload is
restricted to authenticated `manager`/`admin` roles with an extension and size
check — the input is a trusted internal workbook, not attacker-controlled web
input. The remaining `npm audit` entries in the `eslint` chain are
**dev-only**: eslint is not part of the deployed runtime. A working upload was
prioritised over a green `npm audit`, deliberately, because the green audit is
what broke the upload.

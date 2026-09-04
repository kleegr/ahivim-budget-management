# Ahivim Budget Management

The canonical business and role-visibility rules are documented in
[`docs/OPERATING_MODEL.md`](docs/OPERATING_MODEL.md). Read that contract before
changing program rates, budget consumption, employee give-backs, settlements,
or external portal access.

Authorization, utilization and payroll-import tracking for individual service
programs. Replaces a spreadsheet that people have read for years, and adds the
one thing the spreadsheet could not show: whether an individual's authorized
hours are being consumed at the right pace.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS 4 ·
Neon PostgreSQL · Drizzle ORM · ExcelJS · decimal.js · Vitest

## Getting started

```bash
npm ci
cp .env.example .env.local     # fill in DATABASE_URL and AUTH_SECRET
npm run db:migrate
npm run dev
```

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build (embeds migrations first) |
| `npm run lint` | ESLint, zero warnings tolerated |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest. Integration suites run only when `TEST_DATABASE_URL` is set, and are visibly skipped otherwise. |
| `npm run db:migrate` | Apply migrations directly |
| `npm run db:generate` | Generate a migration from the Drizzle schema |

### Running the integration tests

They exercise the real SQL against a real PostgreSQL — no mocks.

```bash
createdb ahivim_test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/ahivim_test npm test
```

## The rules that matter

**Money is never a JavaScript float.** Every authoritative amount and hour is a
`Decimal` (`src/lib/money.ts`). PostgreSQL `numeric` values arrive as strings
and stay strings at the boundary. `Number` is used only for presentation.

**Internal conversion is a ratio applied to the amount**, not a rebuilt
`hours × internal rate`. On the agency-rate ladder: Com Hab × 21/25; Respite,
Day Hab and Supplemental Group Day Hab × 17/19. Self-hire rows never convert.
Rebuilding from the base rate instead of scaling understated the internal total
by $261,818.77 before this was corrected.

**Group services divide the money, not the hours.** For a 13-hour session with
three individuals at a $51 combined rate: each individual is credited the full
13 hours and a $17 rate portion, each allocation is $221, and the combined
amount stays $663. Check number alone never defines a group — detection uses a
composite signature of employee, program, check number, both period dates,
hours and combined rate, and a bucket becomes a group only after six
validations pass.

**Cuts are sequential.** The second cut is taken from the balance after the
first, not from gross. Employee cash is the balance after the second cut minus
the third.

**Employee deals keep the two payment directions separate.** When the agency
receives the funder payment, its percentage is taken from the base/internal
amount and the billed-to-base spread remains the agency's. When a self-hire
employee receives the check directly, any give-back percentage is taken once
from the whole check net. Gross and withholding are shown for context but are
never part of that direct-pay deal calculation.

**Settlement history is append-only.** Deal results become obligations; partial
payments, extra payments/credits, set-asides, and reversals are separate events.
An actioned amount is never silently replaced when a deal or plan changes.

**Imported values are never silently replaced.** A Self-Hire Respite row at $23
where the schedule says $18 is preserved exactly, recorded as a rate exception
with its variance and direction, and still imported.

**Duplicate identity is business identity.** Fingerprints are built from
normalized names, program, check number and date, period dates, hours, rate and
amount — never from a database UUID, which does not exist on a first import and
does exist afterwards. `tests/integration/import-commit.test.ts` commits a
workbook, re-imports the same data, and proves no duplicate transaction is
created.

## Documentation

- `docs/deployment.md` — environment variables, migrations, first administrator
- `docs/authentication.md` — where authority lives, passwords, sessions, roles
- `docs/handoff-project-2.md` — verified findings from the source workbook

Real payroll workbooks are never committed; `.gitignore` excludes every
spreadsheet format.

## A note on ExcelJS and `npm audit`

ExcelJS is loaded with CommonJS `require` in the Node runtime and requires
`uuid`/`archiver`. The dependency overrides keep ExcelJS on `uuid` `11.1.1`,
which provides an explicit CommonJS `require` export, and retain a compatible
archiver chain. `tests/exceljs-cjs-runtime.test.ts` loads and parses a real
workbook with require-of-ESM disabled, so an incompatible dependency update
fails before release. The locked dependency tree currently passes `npm audit`.
See `docs/deployment.md` for the full rationale.

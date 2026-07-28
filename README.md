# Ahivim Budget Management

Internal budget and authorization management system for individual service
programs. Replaces a Google Sheets workbook that tracks authorized hours, hours
used, payroll transactions, agency billing, group services and budget
utilization.

The repository is private and contains no participant data. The source workbook
is never committed.

## Status

Project 2 foundation. The financial rules, the workbook parser and the import
staging pipeline are complete and verified against the real 2025-2026 workbook.
The database schema and migrations are in place. Screens for sign-in, upload
review and the individual utilization report are written but not yet in this
branch — see `docs/handoff-project-2.md`.

## Stack

Next.js 15 (App Router) · TypeScript · React 19 · Tailwind CSS 4 ·
PostgreSQL on Neon · Drizzle ORM · Zod · ExcelJS · decimal.js · Vitest · Vercel

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL and AUTH_SECRET
npm run db:migrate             # creates the schema and seeds programs/rates
npm run dev
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Local development server |
| `npm run build` | Production build (regenerates embedded migrations first) |
| `npm run lint` | ESLint, zero warnings tolerated |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest suite |
| `npm run db:generate` | Regenerate SQL from `src/lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations from a machine that can reach Neon |

## Money and hours

No authoritative financial value is ever a JavaScript number. Money is stored as
`numeric(14,4)` and hours as `numeric(10,4)`; both arrive from Drizzle as
strings and are handled with `decimal.js` in between. `Number()` appears only
where a value is being turned into a progress-bar width.

Authorizations are measured in HOURS. Dollar figures are derived from hours and
the applicable internal rate, never the other way round.

## Documentation

- `docs/handoff-project-2.md` — verified workbook structure, reconciliation
  result, open questions and next steps

## Privacy

Participant and employee names, check numbers and payroll figures never appear
in this repository, in test fixtures, or in application logs. `.gitignore`
blocks `*.xlsx`, `*.xls`, `*.xlsm` and `*.csv` outright.

# Data and Runtime Recovery

Audit date: 2026-09-04 (America/New_York)

This is a factual recovery record for the existing Ahivim application. Neon PostgreSQL remains the application database. The Google Sheet remains a transaction source feed only; no application tables were recreated in Google Sheets.

## Audited production baseline

| Item | Verified value |
| --- | ---: |
| Production Git commit | `bca9ca6c8f5d806fa73fd5dc3e98001bb668f74d` |
| Applied migrations | 41 (`0000` through `0040`) |
| Database tables | 73 |
| Payroll transactions | 5,334 |
| Individuals | 47 |
| Employees | 26 canonical records; 27 source labels in committed transactions |
| Programs | 7 canonical records; 6 used by imported transactions |
| Calculation strategies | 23 |
| Physical budget periods | 0 |
| Physical budget authorizations | 0 |
| Payroll-check records | 688 |
| Import batches | 8 |
| Unresolved import warnings | 25,794 |
| Open Sheet-sync conflicts | 1 of 2 recorded conflicts |

The application is connected to the intended Neon project, all 41 migrations are recorded, and the environment, database, schema, and XLSX health checks return healthy results. A disposable Neon branch was created from production before recovery work. Database tests use its direct (session-affine) endpoint because schema migration advisory locks are not safe through a transaction-pooled endpoint.

## Runtime and route audit

Vercel logs for the preceding 24 hours contained one repeated database error, four occurrences total:

```text
[withDb] Database-backed view failed: for SELECT DISTINCT, ORDER BY expressions must appear in select list
```

The error affected Employee Detail. The failing query selected a primary-key-unique employee/account join with `DISTINCT`, then ordered by an unselected timestamp expression. Removing the unnecessary `DISTINCT` fixes the PostgreSQL error without changing result cardinality. A regression test now guards the exact query shape.

Signed-in Owner checks found the following production routes populated and usable: Home, Transactions/Activity, People & Budgets, Financial Setup, Masser, Agency Financials, Reports, the employee roster, an Individual profile, and Scheduling. The inspected Employee Detail route showed an explicit query failure rather than an empty-data state. No other main Owner route failed during this pass.

## Source reconciliation

### Transactions

| Source | Parsed/source occurrences | Exact repeats after first occurrence | Unique exact identities | Latest service period begin |
| --- | ---: | ---: | ---: | --- |
| Attached `Untitled spreadsheet (1).xlsx` | 5,307 | 47 | 5,260 | 2026-07-16 |
| Live Google Sheet export | 5,381 | 47 | 5,334 | 2026-08-01 |
| Neon `payroll_transactions` | 5,334 | — | 5,334 stored rows | 2026-08-01 |

Every attached-workbook occurrence appears positionally unchanged in the live export. The live export appends 74 rows and makes no edits or removals within the older 5,307-row range. Those additions are the August 21, 2026 payroll activity documented in the Owner dashboard.

The equal 5,334 counts initially mask two real differences. One accounting-negative `Denied Billing` source occurrence is absent from the canonical ledger because the prior CSV parser did not recognize accounting-style negatives; all seven historical Sheet imports preserved it as invalid. Conversely, one stored Day Hab transaction is absent from the current Sheet; the sync layer already created an open `missing` conflict and correctly did not delete it. The CSV parser is repaired, but the denied-billing occurrence remains owner-review-only because `Denied Billing` is an operational label, not a canonical Employee to create automatically.

In addition, the source has 47 exact repeated occurrences that are not represented as separate canonical transactions. Because these repeats carry substantive source activity, they cannot be assumed harmless or imported blindly. Recovery records them as a duplicate-occurrence review set. The import and Sheet-sync paths preserve raw rows, fingerprints, natural keys, source batches/runs, canonical links, and correction history. A repeated import/sync does not create new transactions; a changed natural key or a source row that disappears is surfaced for review and never silently deletes ledger history.

Recovery loaded one preserved source/review batch containing all 5,381 live-Sheet rows and inserted zero ledger transactions. The 5,334 canonical identities were already present, while the accounting-negative denied-billing row remained review-only. A second recovery pass recognized the committed batch and wrote nothing.

### Budgets

`Budget copy.xlsx!UpToDate` contains 38 authorization-period rows for 25 normalized people and 68 nonblank `Original` values. The identity is Individual plus renewal date; the 13 repeated names belong to different renewal periods and are not duplicate people. Source renewals span 2026-09-01 through 2027-08-01. The hidden source row 7 is included. Two billed person/program combinations have no source authorization and remain visible for review.

All 231 cached `Billed`, `Original`, and `What's Left` formulas reconcile to `Original - Billed`. Only `Original` is eligible to become authorization truth. `Billed` is recomputed from committed transactions, and `What's Left` is derived. Five source cells show negative remaining hours and remain visible as over-authorization review conditions.

Production has no physical `budget_periods` or `budget_authorizations` rows. The current populated budget UI derives effective hours from Financial Setup strategies, which kept the route useful but is not a substitute for the workbook's explicit historical authorizations. Recovery therefore classifies and inserts only missing period/authorization facts, preserving existing canonical people and programs and refusing ambiguous matches.

The workbook formulas use an inclusive renewal boundary. The application uses a non-overlapping annual period ending the day before renewal. The recovery importer uses the application's canonical non-overlapping periods and reports the boundary difference rather than creating overlapping authorizations.

### Calculations

The Calculations workbook contains 26 rows linked to 23 canonical people and is treated as a Financial Setup reference, never as a person master. Multiple account rows for one Individual remain multiple strategies linked to one canonical Individual. Cached values and formulas are read together, the saved month divisor is preserved, cuts remain sequential, and the entered `After All` value remains the approved monthly amount even when it differs from the calculated suggestion. Twenty-four rows use divisor 12; the shifted irregular row preserves its entered divisor 7 and manual values.

Known irregular rows are not inferred by column position. The shifted irregular row and the placeholder row are classified for review unless their intended values can be reconciled unambiguously. Source rates are retained as historical provenance or effective overrides; they are not hardcoded as universal application rates.

## Production-derived recovery branch validation

Recovery was applied on the clean production-derived Neon branch only. Production remains at the audited baseline above and has not received these data or code changes.

| Item | Verified post-apply value |
| --- | ---: |
| Applied migrations | 42 (`0000` through `0041`) |
| Database tables | 74 |
| Payroll transactions | 5,334 |
| Individuals | 47 |
| Employees | 26 |
| Programs | 7 |
| Active calculation strategies | 25 |
| Budget periods | 35 |
| Budget authorizations | 63 |
| Payroll-check records | 688 |
| Import batches | 9 |
| Unresolved import warnings | 26,110 |
| Sheet-sync conflicts | 2 recorded; 1 open |

The exact identity correction applied once and was a no-op on its second run. The three affected similarly named individuals remain distinct canonical identities, and the corrected transaction links remain assigned to the intended person.

Budget recovery applied 35 periods and 63 authorizations. Its repeated dry run classified all 35 periods and all 63 authorizations as exact, with zero different records; three period cases and seven authorization cases remain review items rather than inferred inserts. A second apply wrote nothing.

Calculations recovery inserted two missing active strategies, producing 25 active strategies. All 26 workbook rows have retained source provenance. Ambiguous placeholders remain review-only. A second apply wrote nothing.

## Repairs performed

1. Created takeover branch `takeover/2026-09-04` from the verified current `main` commit.
2. Created separate disposable integration and clean production-derived Neon branches and audited all counts before isolation or recovery.
3. Fixed the Employee Detail `DISTINCT`/`ORDER BY` query and added a focused regression assertion.
4. Corrected check-count reporting to use the complete identity: Employee, normalized check number, check date, period begin, and period end. Reused numbers across dates/periods no longer collapse, line items within one check do, numberless dated checks remain countable, and wholly unidentified rows do not.
5. Updated stale integration fixtures so recorded actuals come from `payroll_transactions`, not planned schedule rows.
6. Added guarded, dry-run-first Budget and Calculations reconciliation/import paths with explicit exact, missing, different, ambiguous, historical, duplicate-label, and review classifications. Applying missing facts is transactional and idempotent; a repeated apply creates no duplicates.
7. Added workbook provenance for recovered Financial Setup rows without replacing current canonical records or prior revisions.
8. Added guarded transaction recovery that understands accounting-style negatives, preserves every source occurrence and review decision, and never silently deletes or duplicates canonical ledger history.
9. Disabled automatic fuzzy person merges in matching, import, migration, and management paths. Identity corrections now require an exact, auditable operation.
10. Rebuilt Transactions data projection and grouping so payroll checks join the correct employee, verified gross/net/withholding values appear only for verified checks, complete check identities are respected, and sensitive values are redacted server-side when required.
11. Repaired Individual and Employee profile state: effective-dated assignments and strategies, authoritative `After All` totals, future-only upcoming schedules, Direct/Agency/Unknown monthly reconciliation, and explicit availability errors instead of false empty states.
12. Restored Financial Setup calculation history with active-only totals, archived-history visibility, restore support, editable notes for current records, and read-only enforcement for archived revisions at both client and server boundaries.
13. Added the stable Budget Status `?sheet=up_to_date` view with current-period-first Billed, Original, and Left values by program; historical/upcoming expansion; search and filters; totals, warnings, and transaction drilldowns. Blank source `Original` cells no longer create false authorizations.
14. Added a dry-run-default production recovery runner with explicit production-only safeguards, backup-branch confirmation, fixed recovery order, transaction boundaries, and repeat-apply verification support.

## Verification completed

- The full non-database test suite passes: 196 files and 1,182 tests.
- The targeted database integration set passes serially: 17 files and 136 tests.
- Full lint and typecheck passed at the integrated checkpoint before the final fixture adjustments.
- Clean-branch identity, Budget, Calculations, and Transactions recovery each applied once and then produced no duplicate writes on repetition.

## Remaining release gates

- Re-run final lint and typecheck after the last fixture adjustments, complete the full serial integrated database suite, and produce a clean production build.
- Fetch the latest `main`, reconcile any intervening changes, and repeat the required verification if the release diff changes.
- Deploy a preview against the clean recovery branch, then complete signed-in desktop/mobile route, workflow, and browser checks and inspect preview logs.
- Back up production immediately before any production migration or backfill.
- Apply and verify migration `0041`; the recovery runner now fails closed unless its ledger entry, provenance table, and source-key index are all present.
- Run the guarded production recovery dry run, apply it in the fixed order, run it a second time to prove zero duplicate writes, and reconcile production counts and totals.
- Promote the verified build and confirm the Employee Detail fix and recovered Owner workflows against production-shaped records and production logs.

This file must be updated with final test, preview, and production evidence as those gates complete.

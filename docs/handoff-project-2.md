# Project 2 handoff

## Summary

The financial rules, the workbook parser and the import staging pipeline are
built, pushed and verified end to end against the real 2025-2026 workbook: all
3,069 transaction rows parse, every program and person resolves, 356 group
sessions validate, and both of the workbook's own control totals reconcile.

What is not done: no migration has been run against Neon and no data has been
committed to the database, because this environment could not reach Neon and had
no way to set environment variables on the Vercel project.

---

## Verified workbook structure

Source file: `Excellent_Staffing_2025-2026.xlsx`, 308,511 bytes,
SHA-256 begins `ded0dbc7002f78be`.

### Ahivim sheet

3,071 rows x 25 columns. Header on row 2, first transaction on row 3,
**3,069 data rows, no blank rows**.

Three column labels differ from the original brief. The data is what the brief
described, but the labels matter for header matching:

| Col | Actual header | Holds |
| --- | --- | --- |
| A | Pay to | Payee |
| B | Check Date | |
| C | Check Number | |
| D | Code | Always `RG` in this file |
| E | Hours | Employee physical hours |
| F | Rate | **Combined** rate on a group row |
| G | Amount | Agency gross |
| H | Total Net Pay | |
| I / J | Period Begin / End | |
| K | **Paid CC2 Description** | Program |
| L | **Paid CC3 Description** | Individual |
| M | **Employee Memo** | Employee |
| O | Non contract | |
| P | Amount | Internal amount |
| S | Total Net Pay | Deduplicated net pay |

**Row 1 carries control totals** — not mentioned in the brief, and the reason a
real reconciliation is possible:

| Cell | Formula | Value |
| --- | --- | --- |
| P1 | `SUBTOTAL(109, P3:P3071)` | 1,430,370.965 internal amount |
| Q1 | `SUBTOTAL(109, G3:G3071)` | 1,575,583.05 agency gross |
| R1 | `Q1-P1` | 145,212.0853 agency retention |
| S1 | `SUBTOTAL(109, S3:S3071)` | 1,516,250.51 deduplicated net pay |

### Calculations sheet

41 rows x 21 columns. Header row 1, rates row 2, **23 account records in rows
5–27**.

All six internal rates confirmed in row 2: ComHab 21, Respite 17, SHCH 38,
SHR 18, DayHab 17, SDH 17.

Columns G–L hold **authorized hours** per program. `N` (Yearly Gross) is
`SUM(hours x rate)` across those columns, which confirms hours are the
authoritative authorization and the dollar figure is derived.

`P` (Gross Net) implements the sequential cut exactly as specified:

```
O - (O * C/100) - ((O - (O * C/100)) * D/100)
```

The second cut is taken from the balance after the first. `Q` (Net) is
`SUM(P, Clock, Adjustments)`. `R` is "After All", the third cut.

---

## Column P: the actual rule

Across all 33 distinct program/rate combinations, the ratio of column P to
column G is exactly one of three values:

| Ratio | Meaning | Applies to |
| --- | --- | --- |
| 0.84 | 21/25 | Com Hab priced on the $25 agency rate |
| 0.894737 | 17/19 | Respite, Day Hab, Suppl. Group Day Hab on $19 |
| 1.0 | retained | everything else, including all self-hire rows |

The conversion is a **ratio applied to the amount**, and it fires only when the
row's rate sits on the agency-rate ladder. This matters for groups: a
three-person Day Hab row carries a combined rate of 3 x $19 = $57 and an
internal amount of 3 x $17 = $51/hr. Rebuilding from the $17 base rate instead
of scaling by 17/19 understated the internal total by **$261,818.77** before
this was corrected.

Inferred agency rates: Com Hab $25, Respite/Day Hab/Suppl. Group Day Hab $19.
Self-hire programs have no agency rate and never convert.

---

## Group services

**356 groups detected, 0 requiring review.**

Group sizes 2 to 6 appear, and the workbook prices them off both ladders:

- internal ladder: 34, 51, 68, 85, 102 (2x, 3x, 4x, 5x, 6x $17)
- agency ladder: 38, 57, 76, 95, 114 (2x, 3x, 4x, 5x, 6x $19)

Detection buckets rows by a composite signature of employee + program + check
number + period begin + period end + hours + combined rate. Check number alone
is never used. A bucket becomes a group only after six validations pass:
distinct individuals, matching hours, matching employee, matching program,
combined rate reconciling to group size x a configured base rate, and the money
dividing equally. A bucket that fails any check produces **zero allocations**
and a review warning.

Division rule, as confirmed by the business owner:

```
employee physical hours : 13     stored once on the session
group size              : 3
each allocation hours   : 13     NOT 13/3
each allocation rate    : $17    $51 / 3
each allocation amount  : $221   13 x $17
combined group amount   : $663   13 x $51
```

The money divides. The hours do not.

---

## Reconciliation result

| Measure | Workbook | Application | Status |
| --- | --- | --- | --- |
| Agency gross | 1,575,583.05 | 1,575,583.0500 | exact |
| Internal amount | 1,430,370.965 | 1,430,370.9641 | 0.0009 difference |

| Count | Value |
| --- | --- |
| Source rows | 3,069 |
| Valid | 3,069 |
| Invalid / unparseable | 0 |
| Unknown programs | 0 |
| Unmatched individuals | 0 |
| Unmatched employees | 0 |
| Ambiguous names | 0 |
| Rate exceptions | 248 |
| Possible duplicates | 310 |
| Confirmed duplicates | 0 |
| Groups detected | 356 |
| Groups needing review | 0 |
| Distinct individuals | 33 |
| Distinct employees | 23 |

This is a **staging** result. Nothing has been written to a database.

---

## Rate exceptions

248 rows sit on neither the internal nor the agency rate ladder. Almost all are
Self-Hire Respite, whose configured rate is $18:

| Rate | Rows |
| --- | --- |
| 15 | 2 |
| 15.5 | 3 |
| 16 | 16 |
| 17 | 23 |
| **18 (expected)** | **36** |
| 23 | 126 |
| 25 | 16 |

Self-Hire Com Hab (configured $38) also shows 21 rows at $35 and 41 at $40.

Only 36 of 222 Self-Hire Respite rows are actually at the configured rate, and
the most common rate is $23. Every imported rate is preserved exactly; the
variance is recorded in dollars and percent with a direction, and the row still
imports.

---

## Name matching

Two near-duplicate pairs were found and **not merged**:

- an employee pair differing by one transposed vowel (191 rows vs 7 rows) — this
  is the misspelling the brief predicted, and it is in the payee/employee data,
  not the individual data
- an individual pair differing by one letter

Both are surfaced as alias candidates for a human to approve. Once approved they
become permanent aliases and match exactly on future imports.

---

## Known workbook defects

**Calculations row 12** is broken and should be corrected at source:

- its Monthly Gross is `N12/7` rather than `/12`
- its cut formula references columns B and C instead of C and D, so a value of
  24 that should be a date is being used as the first cut percentage
- its Yearly Gross includes a stray `F12*F$2` term

The application preserves the imported values and calculates its own result
independently, so this row does not corrupt anything downstream. It is the row
the brief referred to; **the /7 is a defect, not a seven-month period.**

**Calculations column S** holds a text category label: `Account` (10 rows),
`C` (12), `c` (1), blank (18). Its meaning is unresolved. It is preserved as raw
text and no logic depends on it.

---

## Questions for the business owner

1. **Self-Hire Respite at $23.** 126 of 222 rows are at $23, not the configured
   $18. Is $23 a newer rate that should be added to the rate schedule with an
   effective date, or are these genuinely exceptions?
2. **Calculations row 12.** Should the `/7` and the shifted cut formula be
   corrected in the source workbook? The application ignores both, but the
   workbook's own Net figure for that account is wrong.
3. **Column S on Calculations** — what do `Account` and `C` mean?
4. **Budget period end dates.** The Calculations sheet has start dates only.
   Should the system assume 12 months from the start date unless told otherwise?
5. **"After All" vs Net.** On several accounts the third cut is very close to or
   slightly above Net, which produces near-zero or negative employee cash. Is
   that expected?

---

## Next steps for developer 3

1. **Set environment variables** on the Vercel project: `AUTH_SECRET`,
   `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and `MIGRATION_TOKEN`.
2. **Run the migrations.** Either `npm run db:migrate` from a machine that can
   reach Neon, or `POST /api/admin/migrate` with the `x-migration-token` header.
   Confirm with `GET /api/health/db`, which reports applied migrations, table
   count and row counts without exposing any secret.
3. **Restore the remaining screens.** Sign-in, the individual utilization report,
   the imports list and the transactions table were written but did not make it
   into this branch. The data-access layer they depend on
   (`src/lib/data/queries.ts`) also needs to be re-added.
4. **Re-add the test suite.** 123 tests covering every rule in this document were
   written and passing but are not in this branch. Rebuild them from the rules
   documented here; the group, cut, conversion and reconciliation cases are all
   specified precisely enough to reconstruct.
5. **Build the commit path.** Staging is complete; writing staged rows into
   `payroll_transactions`, `service_sessions` and `service_allocations` inside
   one database transaction is not.
6. **Then** import the historical workbook through the real pipeline and compare
   the committed totals against the staging figures in this document.

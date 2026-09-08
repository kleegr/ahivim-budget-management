# Ahivim Product Traceability

This is the implementation and release contract for the Ahivim agency
operating system. It maps the owner's stated business rules, roles, and daily
workflows to the current shared code tree, with release evidence through 2026-09-08.

A page existing is not proof that a workflow is complete. Code status and
production acceptance are deliberately separate.

## Status Model

- `PRODUCTION VERIFIED`: implemented, deployed with its migrations and
  configuration, reconciled against representative production records, and
  accepted while signed in as the intended role on desktop and mobile. The
  evidence and date must be recorded.
- `IMPLEMENTED`: the workflow and server-side boundary exist and focused
  automated tests cover them. Deployment, real-data reconciliation, and
  signed-in production acceptance remain open.
- `PARTIAL`: meaningful implementation exists, but a known code, data-model,
  or UX gap prevents the full promised workflow.
- `EXTERNAL BLOCKER`: completion depends on production credentials or licensed
  technology outside this codebase.
- `MISSING`: the requested workflow does not exist.
- `WRONG`: current behavior contradicts the business rule.

**Current production verdict:** the dated acceptance log records bounded live
workflows, including the full inbound replay, budget repairs, source NET repairs,
financial exports, and restricted-role access. These results do not certify the
entire operating system or unresolved financial agreements. Passing focused
tests is implementation evidence, not production evidence. Database-backed
suites that skip without `TEST_DATABASE_URL` do not count as database validation.

## Production Acceptance Log

### 2026-09-08 - Integrated final delivery candidate

Baseline: `0bf845dff10b3e2919cb339ba8adcca71e4af12e`, confirmed against
the production deployment. This entry supplements the prior acceptance below;
it does not repeat historical repairs or certify missing business agreements.
No migrations, source repairs, Sheet writes, production payments, or permission
framework changes are included. The delivery branch explicitly disables its
Vercel preview because generic Preview variables inherit production resources.
Browser fixtures use a disposable localhost database and independent test auth.

Changes distinguish held balances from verified zero in individual statements,
Masser, settlement queues, reports/exports, and scoped employee/agency views.
Mixed positions identify the verified subtotal; approved monthly amounts and
recorded cash/credit history remain intact. Monthly due coverage uses that
service month, while remaining/credit coverage uses the whole scoped ledger.
Explicit zero Financial Setup does not require a fabricated reserve obligation.
Authorized source-review links lead to the exact person's setup or employee deal.
The Budget Planner authorization response also omits financial configuration
metadata. Classes retain draft previews, issued output, and accessible void actions.
Successful shared record forms, assignment changes, and service-schedule changes
reload the current URL so saved records immediately replace stale server-rendered
content. Failed saves retain the open form and its entered values.

Compact coverage of the PDF's 20 success criteria:

| # | Evidence and current disposition |
| --- | --- |
| 1 | Existing financial read-model/export and source drilldown suites; held export cells now remain blank with review status. Unresolved source facts are still excluded. |
| 2 | Existing cohort/filter/export acceptance retained; no aggregation definitions changed. |
| 3 | New `operations-journey.spec.ts` exercises authorization, staffing, recurring visits, time off, revisions and history as Budget Planner; financial response regression added. |
| 4 | The same connected journey uses direct Staffing login; program-budget mutations and financial payloads remain denied. Assignment hours caps are operational staffing data. |
| 5 | `money-operations.spec.ts`, settlement PostgreSQL integration, and Masser browser coverage exercise partial/extra payments, credit, correction, reversal and statements on isolated data. Production agreements/check confirmations remain owner work. |
| 6 | Fresh desktop/phone class allowance → 22 eligible dates → invoice/cover draft → issue → separate receipt → void passed; invoice and cover PDF responses verified. |
| 7 | Scoped portal PostgreSQL regressions cover held/mixed balances, month boundaries, agency attribution and category denial; existing preset contract tests remain required. |
| 8 | Existing access lifecycle/direct-login and owner impersonation coverage retained; prior production impersonation evidence remains dated separately. |
| 9 | Existing inbound-only/idempotency suites and prior authenticated replay evidence retained. No Sheet write-back is introduced. |
| 10 | Existing canonical consumption/authorization suites retained; new connected schedule acceptance separates actual use from future visits. |
| 11 | Class receipt browser acceptance and existing agency financial count-separately suites retained; approved monthly expense remains distinct from reserve cash. |
| 12 | Existing verified-check NET settlement suites retained. Unknown or held give-back projections are no longer ordinary zero. |
| 13 | Existing employee-base/agency-spread calculation coverage retained; no monetary formula changed. |
| 14 | Existing group allocation/matching coverage retained. Ambiguous production group links remain source-review decisions. |
| 15 | Exact permission-gated setup/deal review links added; missing dates, agreements and historical amount basis cannot be inferred. |
| 16 | Connected mutation tests cover save feedback and append-only lost-response retries; no timeout increases are used to mask failures. |
| 17 | Existing audit/immutability suites retained; document and class lifecycle regressions verify preserved history. |
| 18 | All 13 direct-login preset contracts and desktop/phone role suites remain part of the mandatory final browser gate. Earlier production role evidence is not relabeled as fresh acceptance. |
| 19 | New PostgreSQL upload/save/reopen/second-save/restore/archive and class invoice/receipt lifecycle coverage; Blob is mocked in those integration cases. Live provider round-trip acceptance must be recorded separately. |
| 20 | Supported editable forms/overlays retained. Licensed native source-text reflow remains an explicit external dependency; no SDK purchase or Adobe-equivalence claim. |

Release requires both remote Quality Gate jobs and exact deployed-SHA verification.
Final workflow/deployment identifiers and production evidence belong in the
delivery record. A passing release remains qualified while owner source facts,
historical approvals, or the licensed PDF dependency are unresolved. Code recovery
uses the confirmed baseline deployment and current data; no pre-repair database
backup is represented as a lossless rollback.

### 2026-09-08 - Developer 1 final financial controls

PRs #37, #39, #40 and #41 are merged. The startup/performance release #41
merged at `4e30f0569a2e86b537412cd2b48c53d0780d4ce9`; deployment
`dpl_9UbGFposxNjqm5RdDv1LmPiHvoNL` served that exact commit. Both remote
quality runs passed 1,995 unit/PostgreSQL cases and 52 real-browser cases,
lint, types, build, and a zero-finding dependency audit. Ten historical private
fixture cases remained skipped and are not counted as passes. The local
production build and all 52 browser cases also passed. A pooled Neon rehearsal
verified migration transaction ownership, rollback, contention and retry with
all 48 migrations applied once. Production retains 48 migrations and 75 tables.

A fresh main-derived recovery branch was retained before the final financial
changes and verified against the original complete table hashes. The later
48-migration preservation comparison retained all existing financial records.
All three repaired Budget pages passed Owner desktop and phone acceptance.
Canonical budget reads retained every ordered record while eliminating repeated
aggregation; the deployed Owner Home loaded in approximately 2.2 seconds on a
fresh navigation, with matching controls and no desktop or phone body overflow.

All 26 reviewed source NET recoveries were saved through the authenticated
Owner workflow, with exact Saved history links and transaction drilldowns.
Independent full-row comparison proved that only those intended unknown NET
projections changed; original import evidence, all other transaction fields,
Paid state, checks, obligations and cash history were preserved. Exactly 26
attributed acceptance audits were appended. Acceptance, retry, Undo and Undo
retry also passed for all 26 source cases on a disposable real-source clone.
Current source grouping independently passes all 26 cases. One existing,
exactly audited employee merge resolves the retained archived-name alias;
no new identity decision or historical reassignment is required.

Two subsequent authenticated inbound runs,
`101ccb79-783e-472f-be0e-bf5d873d8ec8` and
`c62cc8c2-3301-4cba-8d5b-f55f9c0c9fc5`, read the same complete designated
source. Each added, updated, flagged and failed zero rows. Only run history
changed among the 75 table controls; all accepted NETs, transactions, Paid
states, payroll checks, obligations and cash events remained identical.
The configured hourly cron, authorized scheduled history and daily/off-window
behavior were inspected. An authorized controlled cron request returned the
expected off-window result; an unauthenticated request was rejected. Google
Sheets remains permanently inbound-only, including Paid. Editing access and
write-back are not release requirements.

Two authenticated Money operations refreshes then created, changed, voided or
duplicated no obligations. Independent proofs retained all 80 original full
obligation rows and all cash history, with only the expected review/freshness
state and one refresh audit changing. The second replay changed only freshness
timestamps and its audit. Source holds remain explicit and block new
financial activity. Missing agreements, check verification, unknown setup dates
and legacy amount-basis decisions were preserved for review, not guessed.

Owner Agency Financials reconciled its selected-month screen, actual CSV and
Excel downloads and exact transaction links. Incomplete expense coverage remains
visible in the result and exports. Issued invoices are not received income.
Positive check/payment/credit/correction/receipt cases use isolated PostgreSQL
and browser fixtures; no synthetic production money was created to claim live
acceptance. Later export clicks produced no new captured download; an ordinary
navigation to the observed CSV link explicitly returned the browser's
`net::ERR_BLOCKED_BY_CLIENT`. These attempts are not counted as new downloads.

The final implementation follow-up carries the same source holds into Masser,
individual statements and put-away reports, keeps approved monthly amounts and
cash history visible, and counts the full scoped check population before the
display limit. Fresh NET checks include canonical names, approved aliases and
exact audited merge lineage; uncertain compatible identities fail closed.
Both bounded changes passed independent review and dedicated PostgreSQL/UI
regressions. New-source-row regressions also exposed assignments to an archived
predecessor after an approved merge and creation of a second person from an
approved individual alias. This can put budget usage against the wrong person.
Staging and commit must preserve approved employee and individual identities,
revalidate them before writes, and report only actually created people. Changed
source figures after an approved merge must also remain attached to their
recorded source identity: they enter explicit review instead of creating a
second transaction. Canonical and recorded source keys share a deduplicated
candidate index; competing transaction claims remain ambiguous. Real employee
and individual merge regressions cover unchanged, changed, reordered and full
snapshot replays, explicit apply/dismiss, and preserved financial history.

The full current-source identity comparison found three previously imported
payroll/allocation pairs still assigned to an archived individual after an
existing approved merge. A narrow audited data repair is being rehearsed;
source records, fingerprints, dates, money and payment history must remain
unchanged. These proven person bindings require no new business decision.
A fresh retained recovery copy matches all 75 production table controls.
The final combined release, bounded repair and live acceptance remain pending
until recorded by exact merged commit in the Developer 1 completion report and
existing tracker. No schema migration is required. The dated release records
below remain historical evidence.

### 2026-09-08 - Developer 1 deployment and live controls

PRs #34, #35, and #36 are merged. Production deployment
`dpl_DHCujvX6HcTcq2MVw4iz91igYATA` serves exact commit
`aea9488d345d88383db2dc99b7d1f39d25bdf2e4`. All 46 migrations are
applied; the original 44 checksums and all 72 existing business-table hashes
were preserved across deployment. A retained main-derived recovery branch was
verified against 43 exported financial-table hashes before production changes.
The same migrations passed a PostgreSQL 17 clone rehearsal and a zero-change
retry. The final merged tree passed the remote application gate (1,789 tests;
10 historical private-fixture skips), all 35 browser cases, lint, types, and
the production build. Current private payroll evidence was separately replayed
against an isolated database; it is not committed to this public repository.

One authenticated inbound sync completed under the owner account. Canonical
transaction counts, money, Paid state, payroll checks, obligations, and events
were unchanged. Live inspection found that 26 recovered source NET values still
had unknown canonical NET and no review flag. The follow-up adds a versioned
source-evidence pass that creates review without overwriting financial facts,
including tracking already bootstrapped by the first deployed sync. Repeated
source runs, explicit acknowledgements, restoration, and explicit zero have
regressions. Two authenticated post-fix runs remain an acceptance requirement.

Live Home inspection also found stale individual receivables described as
verified employee give-back. The follow-up suppresses stale monetary actions,
links to money refresh/review, uses neutral recorded-receivable wording, and
retains missing-expense coverage in the owner actual-result label and source
link. Unit and PostgreSQL regressions pass; affected desktop/mobile acceptance
and exact follow-up deployment verification remain open.

At 2026-09-08 03:05 UTC, a separately reviewed, source-pinned production budget
repair committed exactly two periods, eight authorizations, and ten attributed
audits. It preserved all prior 35 periods and 63 authorizations and 13 protected
financial-table hashes. An API retry inserted zero records or audits before the
outer transaction committed. Current effective authorization controls changed
from 69 / 45,278 hours to 71 / 46,175 hours, as predicted by the record-level
source bridge. This is verified production data repair; the three affected
Budget pages still require signed-in browser acceptance. Missing setup dates,
ambiguous identities, and conflicting approved monthly amounts remain review
items; no agreement or accounting treatment was invented.

Restricted-role provisioning and privacy acceptance are coordinated with
Developer 2. Both developers' preview branches use isolated databases and
independent session secrets. Production synthetic financial tests remain
prohibited. These controls do not mark an entire business workflow
`PRODUCTION VERIFIED` before its remaining acceptance evidence is complete.

### 2026-09-08 - Developer 2 access release and bounded production acceptance

PR #38 is merged at `af09541e6d9ce2395b597273e9e63fa3689c6a07`.
Production acceptance was performed against the combined release
`f902f35d7248a9cf2c924617edcca223e648eae4`. The release gate passed
1,928 tests and 50 browser cases; 10 historical private-workbook tests remained
skipped and are not counted as passing evidence. Developer 1 independently
verified that all 74 pre-existing table contents and the original 46 migration
checksums were unchanged, with all 48 migrations applied.

- Document list, metadata, source, version, file, draft, editor, upload, and
  generated-source entry points enforce current record and category access.
  Existing unclassified documents remain preserved and Owner-only. Owner
  classification and explicit recipient approval use the existing library.
- External publication stores a separate immutable PDF reconstructed on the
  server from validated opaque pixels. Source files, hidden text, metadata,
  attachments, originals, and editor history are never delivered through the
  approved-output routes. Current category denials and exact person/dated
  agency scope are checked again when listing or downloading an output.
- Account transitions replace previous portal authority atomically; partial
  permission edits preserve omitted controls. Disable and password reset revoke
  existing sessions. Sign In As uses the target's current permissions, retains
  the Owner audit actor, prevents chaining, and offers Return to your portal.
- Planner/person responses use restricted field shapes. Inactive or archived
  authorizations cannot be changed by planning-only users. Direct employee and
  agency checks require complete, attributable source sets; related people and
  mixed checks do not widen a portal's scope.

The 13-preset route/action/field contract remains in
`tests/e2e/access-contract.ts`. All 13 account presets were provisioned through
normal application controls and signed in directly in production. On that tested
release, server-boundary checks and desktop/390-pixel phone reviews completed
for all 13. Owner Users and Settings were checked in both viewports, Office
Manager's dashboard fully loaded in both, and Agency Collector's desktop
portal fully rendered before its review was recorded.

Owner used Settings to Sign In As Budget Planner. The target session received
`403` for administration and the same 27 safe employee projections as direct
Budget Planner sign-in. The persistent Return button on the phone restored
Owner administration (`200`) and returned to the dashboard. All 12 temporary
non-Owner acceptance accounts were subsequently disabled through normal UI
controls and confirmed inactive through the server. The same previously
legitimate Parent session then received `401` for its portal. The two real
active users were untouched. The temporary Owner is retained for Developer 1's
final financial acceptance; its later disable/cleanup remains pending.

A directly signed-in Parent opened both legitimately bound real profiles and
received their HTML and CSV statements; an unrelated individual's CSV returned
`404`. Independent inspection of the actual browser download confirmed the
`Month`, `Billed`, and `Set aside` aggregate-only structure, 12 monthly rows and
one total, with no employee identities, payroll/check details, gross, net, or
tax fields. Private evidence retains the download hash and audit without
committing personal records or financial amounts.

The isolated live preview completed normal Class Billing upload, annotation,
sanitized version save and reopen, Owner approval of the exact version and
recipient scope, and a read-only Parent download. Independent parsing and
rendering of the downloaded PDF confirmed the visible test content and absence
of hidden metadata, attachments, source objects, and the source sentinel in
both raw bytes and decoded streams. Owner revocation then denied detail and
file access using the same previously legitimate Parent session and removed
Approved documents navigation. The preview database, private Blob store, and
session secret were isolated from production; the publication was revoked and
its two non-Owner test accounts were disabled.

At that acceptance, production had no verified employee checks or give-back
records, so those positive paths are evidenced only in isolated tests. The
Employee evidence field `directActivityCount: null` was unmeasured; it is not
proof of zero activity or of a successful positive-history workflow. Production
also had no approved document publications or issued invoices; document
publication and invoice positive paths remain isolated-only evidence. Independent
reviews covered authentication, portal, document, sanitizer, and navigation changes.
The initially observed approximately 59-second Owner dashboard load and the
migration-session-lock startup and budget-query performance follow-ups are
separately owned by Developer 1, who subsequently merged PR #40 at `87538c1`.
This record attests to the tested `f902f35` release, not the later revision.
These access results do not mark those follow-ups, the entire operating system,
or its remaining business workflows `PRODUCTION VERIFIED`.

#### PR #42 account-action feedback - production verified

PR #42 merged at `46cb4f9b8f14f2d3974cddf7eaec0977f951646e` after incorporating
the accepted Developer 1 startup release. Deployment
`dpl_H44nrG2BXBjCxdzaW3m8yRUK7qaw` was independently verified READY on the
production aliases at that exact commit. Its final head
`79d9086da5b53c3c9c771231d4fbb84de3c23b89` passed remote runs `34193158856`
and `34193157626`: 1,994 tests across 287 files, 54 browser cases, lint,
types, the zero-finding dependency audit, and build. Ten historical private
fixture cases remained skipped. Regressions verify that a successful mutation
updates the UI and retains its credential result even when the subsequent list
reload fails or stalls; explicit retry reloads the list without repeating the
mutation.

On isolated deployment `dpl_aEvMVAffwz3wmddhJKsxAonbJtti`, normal Owner login
and account enable/disable each passed on desktop and a 390-pixel phone viewport.
Observed updates took 383-809 ms without a full-page reload, responses remained
private/no-store, and the temporary account was disabled at the end. This is
bounded automated and isolated-preview evidence. Final production normal Owner
sign-out/sign-in and Custom Access enable/disable also passed on desktop and
a 390-pixel phone. Four updates took 300-570 ms without full-page reload or body
overflow, and responses remained private/no-store. All 13 temporary acceptance
accounts, including the temporary Owner used for financial verification, were
disabled through normal controls. The two original active users were unchanged.
The old temporary Owner session was rejected with 401; the original Owner
session was restored. The earlier retained-Owner cleanup note is superseded.

### 2026-09-07 - Developer 1 financial release in preparation

The Developer 1 assignment continues from PR #33, commit
`1b6ecbcba6d26f00690787662056e8099ee50fce`, and preserves the existing
requirement inventory in `AHIVIM 100% COMPLETION TRACKER (1).xlsx`.
The following are implementation/rehearsal results, not production acceptance:

- Inbound sync preserves pending schedule matching across changed snapshots and
  failed source reads. Truncated quoted CSV is rejected before missing-source
  reconciliation. Exact repeats remain source evidence. Google Sheets remains
  permanently inbound-only, including Paid state.
- Budget retries replay their original result. Renewal changes preserve prior
  consumption. Confirmed group-session allocations credit each individual's full
  hours consistently in budget balances, histories, profiles, and existing scoped
  portal projections. Ambiguous legacy rows retain their prior treatment. Money
  allocations and role boundaries do not change.
- Financial Setup preserves explicit zero overrides, legacy seven-month rows,
  missing effective dates, and entered small percentages. Archived rates do not
  silently become active calculation inputs.
- Settlement refresh separates unresolved source holds from unrelated known
  obligations. Held roots and correction descendants cannot receive new money
  activity, including either side of a paired credit reversal. Existing immutable
  obligations, events, and audit history remain intact. Check confirmation checks
  the complete matching source identity across import batches.
- Owner actuals identify missing expense coverage in the screen and exports,
  retain valid income, and expose exact source identifiers. A receipt whose prior
  split has expired requires an approved effective replacement, including a valid
  zero-percent arrangement. Issued invoices remain receivables rather than income.
- Migrations `0044` and `0045` rehearsed from the 44-migration baseline. Business
  table hashes and a synthetic partial-payment balance were preserved. A second
  migration pass applied nothing. This disposable rehearsal is not a production
  recovery point.

The existing tracker references for this work include rows 422-444 (inbound),
466-573 (budgets/setup), 721-730 (group hours), 748-799 (checks/settlements),
930-956 (reports/receipts), and 1182-1193 (controlled source cases).
At preparation, post-deployment requirements 1407-1409 awaited authenticated
live exports, two inbound syncs, and duplicate checks. The September 8 final
financial-controls entry supplies that bounded evidence without claiming
unrelated positive financial workflows in production.

At the preparation baseline, production served PR #33. Public health checks passed and
the cron route rejected unauthenticated requests. Runtime logs showed hourly
accepted cron requests, including recovered database connection retries. Those
HTTP responses do not establish which scheduled runs imported data: configuration
and database run history still required authenticated inspection. Production
sign-in, a fresh verified recovery point, and merge/deployment were completed
in the September 8 entry above. Bounded direct-role access acceptance is now
recorded in Developer 2's entry; financial workflow acceptance remains with
Developer 1.

### 2026-09-01 - historical release, agencies, and schedule matching

- Production commit `2801cf164af974fc78b8f94dd085ecafab54e3ea`
  deployed successfully through deployment `8dSn6Jz1m2iHy153rgsKtfFgarAP` and was
  assigned to `https://ahivim-budget-management.vercel.app`.
- The database, schema, environment, and XLSX health endpoints returned HTTP
  200. The database reported all migrations applied and 73 public tables; the
  release contains 39 migrations, including the unique recorded-session match
  constraint in migration `0038`.
- Signed-in owner acceptance passed for the agency directory, a scoped agency
  profile, the owner portal, the simple preset-role chooser, and recorded
  schedule matching. The exact service-date transaction drilldown opened 71 of
  5,334 rows for August 1, 2026 and labeled the filter and totals without an
  unrelated all-time context.
- Mobile acceptance at the narrow production viewport passed for the agency
  directory and recorded-match review: the pages rendered without alerts or
  horizontal body overflow. Recent Vercel requests for the tested application
  routes returned HTTP 200 with no runtime error messages.
- This proved that release and these owner views, not every role. At that date, direct
  login, mutation, privacy-payload, and full desktop/mobile acceptance for each
  preset remained open.
- No parent/individual schedule privacy acceptance is claimed for this deployed
  commit: it still returned assigned employee names. The subsequent
  hardening removes employee identity from the parent schedule projection and
  awaited deployment, direct-login payload inspection, and mobile acceptance.
  The bounded September 8 Developer 2 entry supersedes those access gates;
  positive workflow cases outside that evidence remain open.

### 2026-09-01 - owner desktop and source reconciliation

- Production commit `10f914ee4a64f25a1c158c9d92c4d832044327ce`
  deployed successfully with 38 migrations and 73 tables. Database,
  environment, schema, and XLSX health checks passed; production logs had no
  warning, error, or fatal entries during the acceptance run.
- The latest check drill-through opened exactly 74 of 5,334 transactions for
  August 21, 2026. The source rows reconciled to the Owner Home totals:
  $47,973.56 funder billed, $43,210.36 employee base, $4,763.20 agency spread,
  $46,858.71 net payroll, and 1,612.75 hours.
- The August 2026 Agency Financials income drill-through opened exactly 71
  service-dated transactions and reconciled to $47,658.81 actual income. The
  same source set showed $42,940.77 employee base, $4,718.04 agency spread,
  and 1,598.96 hours. This confirms that service-date financial reporting and
  check-date payroll reporting remain distinct and traceable.
- The Masser owner view, exact repair links, read-only Sheet refresh, Owner to
  Owner Sign In As and return, and production health endpoints passed desktop
  acceptance. Private document storage is configured.
- This was partial production evidence, not role completion. At that date, direct-login
  acceptance for every preset, mobile acceptance, mutating Masser/classes/
  document cases, read-only Google source transport, and the licensed source-text
  PDF decision remained open. The September 8 Developer 2 entry records the
  later bounded role-access acceptance; the other workflow requirements remain.

## Canonical Business Truths

| Requirement | Status | Implemented contract and evidence | Open production or data gate |
| --- | --- | --- | --- |
| Transactions and dates | IMPLEMENTED | Committed `payroll_transactions` are the historical truth for what happened. Actuals use `canonical_service_date(period_begin, check_date, period_end)` while retaining check and pay-period fields. Rule effective dates select the applicable rule; they do not replace the transaction date. Evidence: `src/lib/data/transactions-grid.ts`, `src/lib/data/report-queries.ts`. | Reconcile Sheet totals, checks, dates, selected-person totals, exports, and mixed recipients against production. |
| Budget use, renewal, and monthly history | IMPLEMENTED | Operational budget screens and reports use `program_budget_balances`. A known renewal derives the prior annual period; expired and missing renewals remain visible. Used hours come from transactions, pending unmatched schedules are separate, and the monthly trend combines payroll, budget events, and pending schedule. Evidence: `src/lib/data/program-budgets.ts`, `src/lib/data/authorization-portfolio.ts`, `src/components/individuals/program-budget-workspace.tsx`. | Reconcile hourly, manual-dollar, expired, missing-renewal, and renewal-boundary examples in production. |
| Group services | IMPLEMENTED | Each individual receives the full credited service hours while employee physical time is counted once per linked service session. Transaction gross, allocated employee base, and agency-routed employee expense remain row-level and are summed across the individual allocations; they are never collapsed by `service_session_id`. Group review and rate differences retain group context instead of appearing as a generic rate error. Evidence: `src/lib/data/report-queries.ts`, `tests/report-activity-truth.test.ts`, `tests/agency-financial-group-allocation.test.ts`. | Exact physical hours require `service_session_id`. Legacy unlinked group rows remain disclosed at transaction-row level and require source repair for exact historical physical-time deduplication. |
| Funder billed, employee base, and agency spread | IMPLEMENTED | Funder rate/amount, employee base rate/amount, and agency spread remain distinct. A $25 funder rate does not become $25 employee pay when the employee base is $21. Taxes do not explain this difference. Evidence: transaction and report read models plus `src/lib/manage/payment-attribution.ts`. | Reconcile representative flat-rate, per-individual-rate, and group-rate cases in production. |
| Direct employee give-back | IMPLEMENTED | The configured direct-pay rule is applied once to the whole verified check NET, never gross, hourly values, or every transaction row. Taxes are visible as gross minus net and are not an agency cut. Imported checks require confirmation before obligations are created. Evidence: `src/lib/manage/direct-pay-operations.ts`, `src/lib/manage/settlements.ts`. | Test mixed-recipient checks, conflicting repeated NET values, partial collections, and corrections with production checks. |
| Individual cuts and put-away | IMPLEMENTED | First and second cuts are sequential. The approved final monthly amount is the reserve target; explanatory cuts do not create duplicate obligations. Statements show target, recorded, corrections/reversals, credit, remaining, and history without employee identity. Evidence: `src/lib/business/calculation-strategy.ts`, `src/lib/data/direct-pay-operations.ts`, `src/app/(app)/masser/individuals/[id]/page.tsx`. | Reconcile one normal month, one credit, one correction chain, and one renewal boundary in production. |
| Agency-routed employee pay | IMPLEMENTED | The agency-routed deal divides employee base, never funder gross. An effective-dated employee-plus-individual compensation rule wins; the employee default is the fallback. Agency spread remains separate, and rule changes invalidate settlement freshness. Evidence: `src/lib/manage/agency-financials.ts`, `src/lib/manage/settlements.ts`, migration `0036_agency_financial_actuals.sql`. | Migration 0036 is deployed. Reconcile specific-rule, fallback-rule, missing-rule, and mixed-routing examples against representative production records. |

## Role And Portal Matrix

Every row below is implemented in code unless marked `PARTIAL`. All 13 presets
passed the bounded direct-login, server-scope, and desktop/phone acceptance on
tested release `f902f35`, as recorded above. Remaining representative daily
workflow and financial reconciliation requirements are listed separately.

| Preset/profile | Status | Home, work, and hard privacy boundary |
| --- | --- | --- |
| Owner | IMPLEMENTED | Whole-agency home, named multi-person activity cohorts, all reports, all people, all money, all settings, user administration, Sign In As, and exact drilldowns. Saved cohorts retain dates, people, employee, and payroll-period filters and are owner-only at the API boundary. Bounded role-access acceptance passed; representative financial workflow acceptance remains with Developer 1. |
| Office Manager | IMPLEMENTED | Everyday internal work, reports, budgets, and financials, without user-account administration. |
| Budget Planner | IMPLEMENTED | Full-roster budget coverage, assignments, employee availability, calendar, and hours-only direct-pay target progress. May create, revise, or cancel active non-Classes hour authorizations. Cannot receive rates, dollars, transactions, payroll, taxes, employee deals, Masser, or manual financial adjustments. Planner mutation payloads and responses are server allowlisted/scrubbed. |
| Staffing Manager | IMPLEMENTED | Finance-free employee directory/detail, weekly availability, time off, assignments, and schedule. Employee APIs expose only identity/status fields; no budgets, rates, notes, external payroll references, checks, taxes, transactions, deals, or settlements. |
| Money Collector | IMPLEMENTED | Masser check confirmation, amounts due, collections, balances/credits, individual put-away, corrections, and statements. No budget planning or owner agency-profit report. |
| Class Billing | IMPLEMENTED | Class allowances, invoices, cover sheets, saved documents, and document editing without unrelated payroll or settlement access. |
| Individual / Parent | IMPLEMENTED | Only directly linked individuals and explicitly granted categories: approved hours/budgets, selected-month financial aggregates, twelve-month trend, and privacy-safe print/download statement. No employee identity, employee check, gross/net, or tax detail. |
| Employee | IMPLEMENTED | Only the linked employee's verified direct checks, allowed gross/net/tax fields, give-back, payments, balance, and direct-pay service history. Agency-routed activity is excluded; capability denials remove fields at the read model. |
| Agency / Provider | IMPLEMENTED | Dated scoped roster, individual/program rollups, granted financial categories, and check-level employee drilldowns. Agency and per-member grants/denials control each category. Whole-check and give-back amounts are hidden for concurrent agency memberships unless every source transaction resolves uniquely to the requesting billing agency. |
| Agency Scheduler | IMPLEMENTED | Agency-scoped assignments and schedule using hours only. No money. |
| Agency Staffing Manager | IMPLEMENTED | Agency-scoped employee roster, assignments, availability, and schedule using hours only. No money. |
| Agency Collector | IMPLEMENTED | Read-only agency financial, direct-check, agency-paid, and settlement views according to explicit grants/denials. It is separate from the internal Money Collector and cannot use global Masser or budget planning. |
| Custom Access | IMPLEMENTED | Starts with no access or portal binding. Only Owner-selected internal workspaces, actions, and directly scoped records are available; omitted permissions remain denied. The no-access preset was included in the 13-role production acceptance. |

Evidence for role definitions and provisioning lives in
`src/lib/auth/account-presets.ts`, `src/lib/auth/access-presets.ts`,
`src/lib/auth/portal-access.ts`, `src/lib/auth/users.ts`, and the
role-specific read models and API tests.

## Operational Workspaces

| Workspace or workflow | Status | Implemented contract | Remaining work before production verification |
| --- | --- | --- | --- |
| Owner Home | IMPLEMENTED | Calm overview of actual activity, canonical budget position, latest payroll, and a distinct actual-money band for monthly income, expenses, agency result, employee collections, agency payments, and individual set-asides. The six money figures share one repeatable-read snapshot and load independently so a financial failure cannot blank the operational overview. Every money value links to Agency Financials or the exact Masser queue. Date/pay-period/employee filters, multi-person cohorts, and named saved views restore in one click. Owner view configurations are sanitized before link creation and denied to non-owner staff at the API boundary. Evidence: `src/components/dashboard/owner-dashboard.tsx`, `owner-people-multi-select.tsx`, `owner-saved-views.tsx`, `src/lib/dashboard/owner-views.ts`. | Reconcile all cards, saved views, and source links against production. |
| Owner Agency Financials | IMPLEMENTED | Owner-only monthly workspace for actual Google Sheet transaction income plus explicitly recorded receipts, approved final monthly set-asides, verified-check taxes/direct employee keeps, agency-routed employee shares, individual split expenses, disclosures, and source drilldowns. CSV and formatted Excel downloads use the same selected-month repeatable-read snapshot as the screen. Issued class invoices reserve budget and remain receivable references; they are neither cash income nor expenses. Missing gross/base/deal/split values are disclosed and excluded, never guessed. Saved setup revisions reconstruct the state effective for each month from August 2026 forward; earlier unavailable history remains visible and uncounted. Evidence: `src/app/(app)/reports/agency-financials/page.tsx`, `src/lib/data/agency-financial-report.ts`, `src/lib/export/agency-financial-report.ts`, `src/components/reports/agency-financial-workspace.tsx`. | Reconcile representative Sheet, manual-receipt, direct-pay, agency-routed, class, split, export, and historical set-aside records in production. |
| Manual and custom-program income | IMPLEMENTED | Owner can record received class payments, reimbursements, custom-program income, or other income; split gross into agency and individual amounts; deduplicate Sheet matches and source references; and void with an audited reversal. A class receipt never consumes the class allowance again because invoice issue/void owns that history. Custom-program income requires an individual, program, effective split, and active dollar budget, with an explicit over-budget reason. Evidence: `src/lib/manage/agency-financials.ts`, `src/app/api/agency-financials/income/*`. | Verify same-Sheet-payment enrichment, separate payments, invoice references, over-budget custom income, and void flows on production records. |
| Individual-program revenue splits | IMPLEMENTED | Owner can maintain audited, non-overlapping, effective-dated agency-share percentages per individual and program. Issued classes use the effective split; 100% agency is the default only when no custom split history says a split is required. Evidence: `individual_program_revenue_terms`, `/api/agency-financials/program-splits`. | Reconcile before, on, and after an effective-date change in production. |
| Employee-person pay rules | IMPLEMENTED | Owner can maintain audited, non-overlapping, effective-dated employee shares for a specific employee and individual. The specific rule precedes the employee default for agency-routed base pay and dirties the settlement ledger on change. Evidence: `employee_individual_compensation_terms`, `/api/agency-financials/employee-terms`. | Migration 0036 is deployed. Rebuild and reconcile affected settlements against representative production records. |
| Transactions | IMPLEMENTED | Spreadsheet-like per-value filters, dates, checks, people, programs, multi-person selection, synchronized totals, row/check modes, drilldowns, and export. Multi-row Money-operation drilldowns now use one bounded source key, resolve inside the viewer's transaction scope, reject stale/copied inaccessible sources, and never interpret an empty resolution as an unfiltered ledger request. Evidence: `src/components/settlements/deep-links.ts`, `src/lib/data/settlement-source-transactions.ts`, `src/app/(app)/transactions/page.tsx`. | Browser-test 1-, 70-, and 201-row source sets, stale links, restricted copied links, performance, keyboard, mobile, and first-click behavior on production payroll. |
| People & Budgets | IMPLEMENTED | All individuals together; renewal as a primary field; configurable columns; with/without-budget and billing-without-budget views; authorized/used/scheduled/after-schedule/remaining hours; pace; monthly history; and safe planner hour edits. Renewal-only entry derives the annual dates. | Reconcile representative hourly, group, manual-dollar, expired, and missing-renewal records. |
| Schedule | IMPLEMENTED | Month/week/day planning; recurring schedules; employee/individual views; assignment, overlap, availability, time-off, individual clash, and budget checks before save; budget coverage; weekly availability and dated time off. New time off produces a finance-free review queue for affected future sessions. Recorded match review is loaded only when opened, exposes hours without money, and separates exact daily facts from pay-period and group records that need human review. One transaction is database-enforced to match at most one visit. Evidence: `src/lib/manage/employee-availability.ts`, `src/lib/manage/reconciliation.ts`, `src/lib/data/planning-reconciliation.ts`, `src/components/schedule/schedule-matching-panel.tsx`, `tests/auto-reconciliation-safety.test.ts`, `tests/planning-reconciliation.test.ts`. | Migration 0038 is deployed and the owner match-review view passed desktop/mobile smoke testing. Production-test time off, recurring visits, exact and ambiguous matches, group review, direct repair links, and finance-field absence with Budget Planner and Staffing Manager accounts. |
| Direct-pay employee targets | IMPLEMENTED | Authorized operators set an employee target gross, cadence, effective dates, and rate; the planner sees only derived target hours, recorded hours, scheduled hours, remaining hours, and status. Evidence: `src/lib/manage/direct-pay-operations.ts`, `src/components/schedule/direct-pay-targets-panel.tsx`. | Production-test weekly, monthly, custom, changed-rate, archived, and already-met targets. |
| Masser | IMPLEMENTED | Dedicated internal collector board, separate from Financial Setup, with imported-check confirmation, employee collections, individual set-asides, statements, credits, corrections, reversals, and history. Exact multi-row source links use one compact server-resolved key; check recording stays within the 200-row mutation limit, while larger sources route to read-only inspection instead of an unsavable form. | Deploy and browser-test compact source routing, then reconcile direct-pay, partial/extra collection, credit, correction, and renewal-boundary cases. |
| Financial Setup | IMPLEMENTED | Owner/manager configures program lines, yearly/monthly values, sequential cuts, adjustments, and the approved final amount, visually separate from Masser. | Reconcile spreadsheet examples and retain owner/manager-only access. |
| Settlement Ledger | IMPLEMENTED | Auditable obligations, payments, multi-select completion, partials, extras/credits, corrections, and reversals for both payment directions. | Production-reconcile ledger freshness and correction chains after every deal/rule type. |
| Employees | IMPLEMENTED | Financial roles see activity, people served, programs, transactions, arrangements, and checks; planning roles receive the separate finance-free directory/detail and availability/assignment workflow. | Verify both variants with representative accounts and inspect server responses for forbidden fields. |
| Agencies | IMPLEMENTED | Owner-only directory and individual agency profiles show selected-month rosters and responsibility, managed and billing-only membership counts, budget hours, schedules, actual recorded totals, and permitted financial summaries from the canonical portal-safe read model. Directory reads stay aggregate-only; a detail route is restricted to the selected agency at the database boundary. | Owner layouts and bounded direct-login access for agency-facing presets passed on the recorded tested releases. Reconcile roster dates, responsibility counts, hours, and actual totals for every agency beyond that access evidence. |
| Reports | IMPLEMENTED | Decision-oriented reports for canonical budget use, exceptions/renewals, actual versus scheduled, program totals, funder/base/spread, employee pay, reconciliation gaps, group activity, setup audit, aliases, and audit history. Actuals come from transactions; program totals separate credited individual hours from physical employee hours. User-entered CSV text is neutralized across shared, report, and portal exports while typed negative numbers remain numeric. | Reconcile filters/totals/exports in production and repair legacy group links where exact physical-hour deduplication is required. |
| Programs | IMPLEMENTED | Reusable global programs support authorization basis, service category, group rules, payment recipient, consumption source, rate scope, renewal policy, standard rates, and individual overrides. A guided form asks the four everyday questions first, keeps rare rules collapsed, derives a short code when omitted, and atomically creates the catalog entry, operating rules, and optional starting rate. | Production-test the common create-program path with a new administrator and reconcile the first assigned authorization. |
| Classes | IMPLEMENTED | Per-individual annual dollar allowance; editable monthly invoice draft; default 22 non-Saturday service dates; atomic issue/void; budget consumption/reversal; cover-sheet attestation; and saved output. | Obtain stakeholder approval for exact branding/signature treatment and visually compare supplied examples. |
| Documents and current PDF editor | IMPLEMENTED | Private PDF library, access-gated streaming, upload, search, archive, immutable save/restore history, drafts, forms, signatures, drawing, page operations, native/OCR text inspection, cover-and-replacement text, imported fonts, and export. Saved versions reopen the retained source PDF and restore editable overlays, forms, page order/rotation, images, fonts, and export mode instead of reopening only a flattened copy; bounded embedded assets retain editable portability. Structured saves validate every page, overlay, form value, asset, ID, size, and reference before storage access while retaining pre-manifest legacy drafts. Missing Blob configuration fails before reserving unusable records. | Isolated live upload/edit/sanitized-save/reopen/approval/download and same-session revocation passed. With no production publications, positive production document workflows, second-save/restore/archive, and font embedding still require representative acceptance. |
| User and agency provisioning | IMPLEMENTED | Simple role/profile chooser, generated temporary password, atomic user plus individual/employee/agency binding, preset access, agency roster dates/responsibility, and agency/per-member capability overrides. Office Manager and custom staff profiles remain available for internal exceptions. | All 13 presets were provisioned through normal UI and signed in directly on tested production release f902f35. Invalid-binding rollback and further role-transition cases beyond the recorded production evidence remain acceptance requirements; no unobserved production mutation is claimed. |
| Sign In As | IMPLEMENTED | An admin can start a server-authorized session as another active user from user administration, sees a persistent banner, can explicitly return, and cannot chain previews. Central audit records retain the owner as the actor and the previewed account as the target; failed start/stop transitions fail closed and remain visible. Evidence: `src/app/api/auth/impersonation/*`, `src/lib/auth/audit-attribution.ts`, `src/components/auth/impersonation-bar.tsx`. | Owner-to-Budget-Planner Sign In As, server restrictions, mobile return, and direct login for every preset passed on f902f35. Other target transitions and failed start/stop recovery retain their regression and representative acceptance requirements. |
| Portal statements, trends, and schedules | IMPLEMENTED | Individual/parent portal supports selected-month detail, a twelve-month default trend (bounded to 24), capability-gated categories, printable statement, and CSV download without employee/check/tax/gross/net leakage. The deployed individual/parent schedule projection returns only date, time, duration, program, and group facts; it omits employee identity, internal IDs, and group peers. Employee views receive only their assigned participants. Evidence: `src/lib/data/portal-schedule.ts`, `tests/portal-schedule.test.ts`, `tests/portal-schedule-ui.test.ts`. | Privacy hardening, direct Parent response/DOM and mobile inspection, both bound profiles, HTML/CSV, an actual downloaded-byte audit, and foreign-record denial passed on f902f35. Empty months, renewal boundaries, full print layout, and schedule/category cases beyond the recorded evidence remain to be verified. |
| Imports, reconciliation, and matching | IMPLEMENTED | Upload/stage/review/commit, duplicate recognition, correction routes, alias decisions, person merges, and payroll-check review exist; actual transaction visibility does not depend on creating a deal for each import. Workbook parsing is field-aware, including recovery of numeric payroll amounts that Excel tagged as date cells. A successful Sheet commit optionally links only unambiguous one-person, non-group, same-employee, same-program, exact-date, exact-hours daily records; optional matching failure cannot turn the committed import into a failed sync and remains retryable from the next refresh. The supplied payroll workbook parses 5,307 valid rows with zero invalid rows and restores 26 previously blank net-pay values. | Commit the original workbooks in production, verify exact auto-match and ambiguous/group review cases, confirm unmatched/invalid rows lead to the exact repair screen, and reconcile post-commit totals and repeated check-number identities. |
| Actionable errors and first-click UX | IMPLEMENTED | Global route-progress feedback covers internal links and native forms; shared mutation controls disable and acknowledge submits while retaining entered work and visible failures; every client component that writes through `fetch` is audited for busy and error paths; server-load failures provide a plain-language retry; and high-use import, transaction, group, collection, financial, schedule-conflict, and role-denial states link to the exact next record or repair screen. A denied redirect now explains that access was blocked after the role-specific home reload, and budget-status failures remain visible without discarding the edit. Evidence: `src/components/app-nav.tsx`, `src/components/auth/access-notice.tsx`, `src/components/manage/client.tsx`, `src/components/ui.tsx`, `tests/workflow-clarity.test.ts`, `tests/transaction-cross-drills.test.ts`, `tests/collections-deep-links.test.ts`. | Bounded signed-in navigation and desktop/phone access acceptance passed for all 13 presets on f902f35. Error recovery, positive mutations, and first-click behavior beyond that scope remain open; dashboard/startup/query performance belongs to Developer 1. |
| Google Sheet read-only refresh | IMPLEMENTED | The authenticated button reads the complete designated source, preserves source evidence and application-owned Paid/review/correction state, and links optional matching review. Two post-repair live runs proved unchanged source adds or changes no transactions, checks, obligations or cash; only run history changed. The code contains no Sheet mutation module or write OAuth scope. | Full-source reads and unchanged replays are production verified. New-row approved-person identity, parser/transport failure recovery and fail-closed inconsistent reads are tested in isolation; retain their final release evidence separately. Sheets is permanently inbound-only; no editing access or write-back is required. |
| Adobe-class source-text PDF editing | EXTERNAL BLOCKER | The current editor is an overlay/form/document editor, not arbitrary reflow of existing source text in proprietary embedded fonts. | Choose and license a commercial source-text PDF SDK, integrate it, and verify embedded-font fidelity on the supplied PDFs; otherwise narrow the product promise to the implemented overlay editor. |

## External Dependencies And Known Limits

| Dependency or limitation | Gate |
| --- | --- |
| Google Sheet read-only transport | Complete designated-source reads and two authenticated unchanged replays passed in production. Digest mismatch is fail-closed; application-owned changes remain in Neon. The owner's inbound-only decision requires no Sheet editing access. |
| Adobe-equivalent source-text editing | Licensed SDK/product decision; the current overlay editor cannot truthfully be called Adobe-equivalent. |
| Legacy unlinked group history | Repair or backfill session links before historical physical employee hours can be exactly deduplicated. |
| Production document storage | Private Blob is configured; isolated live upload/edit/save/reopen/approved-download/revocation passed. Positive production document workflows and the remaining second-save/restore/archive cases are not established by that isolated evidence. |
| Class PDF identity | Owner approval of exact logo, brand marks, signatures, and final rendered examples. |
| Historical approved set-asides | Saved setup revisions provide as-of values from August 2026 forward. Earlier months without trustworthy snapshots remain disclosed and excluded until source history is supplied. |
| Dedicated test database | Final accepted PR #42 used a dedicated PostgreSQL database: 1,994 tests passed alongside 54 browser cases. Ten historical private-workbook skips remain explicitly separate from passes. Current private source evidence was independently replayed on disposable clones and is excluded from the public repository. |

## Remaining Delivery Order

1. Retain the dated `f902f35` access matrix, the later Developer 1 financial
   controls and startup evidence, and PR #42's exact `46cb4f9` production
   acceptance. Every later release still requires its own commit/deployment
   record; earlier tested revisions are historical evidence.
2. Preserve completed 13-preset direct-login, desktop/phone, server-scope, and
   Owner-to-Budget-Planner Sign In As/return evidence. Complete first-click,
   error-recovery, and positive workflow cases beyond that bounded acceptance.
3. Retain each dedicated-PostgreSQL release gate, including final accepted
   PR #42's 1,994 tests and 54 browser cases and its lint/type/build evidence.
   The 10 historical private-workbook skips are not passes; preserve separately
   replayed current-source evidence and replay the old fixtures when supplied.
4. Reconcile representative production truth end to end: one normal and one
   group transaction, a renewal boundary, billing without budget, direct and
   agency-routed pay, Masser credit/correction, class invoice, manual income,
   custom split, employee-person rule, and owner agency result.
5. Retain the completed full-source, authenticated inbound replays and
   application-owned-state preservation proofs. Google Sheets is permanently
   inbound-only. Private Blob is configured but still needs its complete
   production document round trip. Repair legacy group links needed for exact
   history when trustworthy source links are available.
6. Preserve the recorded normal-UI provisioning and direct-login evidence for
   all 13 presets. All 13 temporary accounts are now disabled, with the original
   two active users unchanged and revoked-session checks completed. Execute
   the remaining daily-workflow cases below with representative records and
   retain private screenshots/exports, inspected API payloads, date, and result.
7. Obtain class PDF visual approval and make the explicit Adobe SDK versus
   overlay-only product decision.

## Role-By-Role Production Acceptance

Provisioning, direct login, desktop/phone views, and bounded server access passed
for all 13 presets on `f902f35`. This matrix retains the broader daily-workflow
requirements; an empty response or an unmeasured count does not prove a positive
workflow. In particular, Employee `directActivityCount: null` was not measured.

| Role/account | Daily workflow that must pass | Privacy and authority proof |
| --- | --- | --- |
| Owner | Filter a multi-person cohort; open source transactions; inspect canonical budgets; run/export reports; reconcile Agency Financials; create a user; Sign In As and return. | All agency data is available; owner-only routes reject non-admins. |
| Office Manager | Complete a normal transaction, budget, schedule, report, Masser, and financial workflow. | User administration and owner-only Agency Financials remain unavailable. |
| Budget Planner | Create/revise/cancel an hour authorization; inspect renewal/pacing/history; assign staff; enter availability; schedule within coverage; inspect hour targets. | Navigation and every API response contain no rates, dollars, transactions, payroll, checks, taxes, deals, Masser, or settlement fields. Dollar/Classes authorizations and financial mutations are rejected. |
| Staffing Manager | Find an employee, maintain availability/time off, assign them, and schedule them. | No budget or money route is reachable; employee list/detail response contains only safe identity/status data plus separate planning summaries. |
| Money Collector | Confirm an imported check; record a collection; handle partial/extra/credit; inspect corrections; produce an individual put-away statement. | No budget planning, rates, agency spread/profit report, or unrelated employee financial detail. |
| Class Billing | Add/open an allowance; build a 22-day non-Saturday invoice; issue and void it; edit/save/reopen the PDF and cover sheet. | No unrelated transactions, payroll checks, Masser, or settlements. |
| Individual / Parent | Open the linked person, change month, read the 12-month trend, open both upcoming and full schedule, then print and download the statement. | Cannot enumerate other people; response, DOM, and export contain no `employeeName`, employee ID, other group participant, check number, tax, gross, or net fields beyond explicitly allowed aggregates. |
| Employee | Review every verified direct check in a month, allowed gross/net/tax, direct services, give-back due, payments, and balance. | Only the linked employee appears; denied categories are absent; agency-routed activity is excluded. |
| Agency / Provider | Review dated roster, program/person rollups, granted financials, and permitted employee check drilldowns; change one member override as owner and recheck. | Out-of-roster dates/people and denied member categories are absent from server responses. |
| Agency Scheduler | Assign and schedule the agency's in-scope roster and inspect hours. | No money, budgets beyond allowed hour coverage, transactions, or out-of-agency people. |
| Agency Staffing Manager | Review agency employees, availability, assignments, and schedule. | No money and no employees outside the dated agency roster. |
| Agency Collector | Review only granted agency direct-check, agency-paid, set-aside, and settlement details. | Read-only; no budget planning, internal global Masser, deal editing, or denied financial category. |
| Custom Access | Directly sign in with the no-access preset; verify only explicitly granted workspaces and records after any later tailored configuration. | No implicit portal binding or inherited authority; every ungranted route, action, record, and financial category remains denied. |

For every external or restricted account, use the real preset provisioning flow
and a direct login. Sign In As is an additional owner preview and debugging tool,
not a substitute for authentication acceptance.

## Definition Of Production Verified

A row may move from `IMPLEMENTED` or `PARTIAL` to
`PRODUCTION VERIFIED` only when all applicable evidence exists:

- The exact commit is deployed and all required migrations/configuration are
  present.
- Focused tests and the full required quality suite pass; skipped suites are
  named and resolved.
- Representative production totals reconcile to source transactions, budgets,
  checks, statements, and exports with no guessed values.
- The intended preset can be provisioned in one flow and directly sign in.
- The role's first screen answers its daily questions and every total drills to
  the records that created it.
- Forbidden money and identity fields are absent from server responses, not
  merely hidden by CSS.
- Every problem state provides one plain-language action to the exact fix.
- Buttons acknowledge the first click, prevent duplicate submission, and keep
  entered work after a failure.
- Desktop and mobile workflows complete without overlap, clipping, or
  inaccessible controls.
- Real Sheet sync, private storage, PDF rendering, and exports pass where they
  are part of the workflow.
- Acceptance records the date, environment, account/preset, evidence links,
  reconciled examples, result, and approver.

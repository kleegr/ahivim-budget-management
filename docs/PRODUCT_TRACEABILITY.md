# Ahivim Product Traceability

This is the implementation and release contract for the Ahivim agency
operating system. It maps the owner's stated business rules, roles, and daily
workflows to the current shared code tree as of 2026-09-01.

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

**Current production verdict:** no row in this document is yet
`PRODUCTION VERIFIED`. Passing focused tests is implementation evidence, not
production evidence. Database-backed integration suites that skip without
`TEST_DATABASE_URL` also do not count as production verification.

## Canonical Business Truths

| Requirement | Status | Implemented contract and evidence | Open production or data gate |
| --- | --- | --- | --- |
| Transactions and dates | IMPLEMENTED | Committed `payroll_transactions` are the historical truth for what happened. Actuals use `canonical_service_date(period_begin, check_date, period_end)` while retaining check and pay-period fields. Rule effective dates select the applicable rule; they do not replace the transaction date. Evidence: `src/lib/data/transactions-grid.ts`, `src/lib/data/report-queries.ts`. | Reconcile Sheet totals, checks, dates, selected-person totals, exports, and mixed recipients against production. |
| Budget use, renewal, and monthly history | IMPLEMENTED | Operational budget screens and reports use `program_budget_balances`. A known renewal derives the prior annual period; expired and missing renewals remain visible. Used hours come from transactions, pending unmatched schedules are separate, and the monthly trend combines payroll, budget events, and pending schedule. Evidence: `src/lib/data/program-budgets.ts`, `src/lib/data/authorization-portfolio.ts`, `src/components/individuals/program-budget-workspace.tsx`. | Reconcile hourly, manual-dollar, expired, missing-renewal, and renewal-boundary examples in production. |
| Group services | IMPLEMENTED | Each individual receives the full credited service hours while employee physical time is counted once per linked service session. Transaction gross, allocated employee base, and agency-routed employee expense remain row-level and are summed across the individual allocations; they are never collapsed by `service_session_id`. Group review and rate differences retain group context instead of appearing as a generic rate error. Evidence: `src/lib/data/report-queries.ts`, `tests/report-activity-truth.test.ts`, `tests/agency-financial-group-allocation.test.ts`. | Exact physical hours require `service_session_id`. Legacy unlinked group rows remain disclosed at transaction-row level and require source repair for exact historical physical-time deduplication. |
| Funder billed, employee base, and agency spread | IMPLEMENTED | Funder rate/amount, employee base rate/amount, and agency spread remain distinct. A $25 funder rate does not become $25 employee pay when the employee base is $21. Taxes do not explain this difference. Evidence: transaction and report read models plus `src/lib/manage/payment-attribution.ts`. | Reconcile representative flat-rate, per-individual-rate, and group-rate cases in production. |
| Direct employee give-back | IMPLEMENTED | The configured direct-pay rule is applied once to the whole verified check NET, never gross, hourly values, or every transaction row. Taxes are visible as gross minus net and are not an agency cut. Imported checks require confirmation before obligations are created. Evidence: `src/lib/manage/direct-pay-operations.ts`, `src/lib/manage/settlements.ts`. | Test mixed-recipient checks, conflicting repeated NET values, partial collections, and corrections with production checks. |
| Individual cuts and put-away | IMPLEMENTED | First and second cuts are sequential. The approved final monthly amount is the reserve target; explanatory cuts do not create duplicate obligations. Statements show target, recorded, corrections/reversals, credit, remaining, and history without employee identity. Evidence: `src/lib/business/calculation-strategy.ts`, `src/lib/data/direct-pay-operations.ts`, `src/app/(app)/masser/individuals/[id]/page.tsx`. | Reconcile one normal month, one credit, one correction chain, and one renewal boundary in production. |
| Agency-routed employee pay | IMPLEMENTED | The agency-routed deal divides employee base, never funder gross. An effective-dated employee-plus-individual compensation rule wins; the employee default is the fallback. Agency spread remains separate, and rule changes invalidate settlement freshness. Evidence: `src/lib/manage/agency-financials.ts`, `src/lib/manage/settlements.ts`, migration `0036_agency_financial_actuals.sql`. | Reconcile specific-rule, fallback-rule, missing-rule, and mixed-routing examples after migration 0036 is deployed. |

## Role And Portal Matrix

Every row below is implemented in code unless marked `PARTIAL`, but every
role still needs direct signed-in production acceptance.

| Preset/profile | Status | Home, work, and hard privacy boundary |
| --- | --- | --- |
| Owner | IMPLEMENTED | Whole-agency home, named multi-person activity cohorts, all reports, all people, all money, all settings, user administration, Sign In As, and exact drilldowns. Saved cohorts retain dates, people, employee, and payroll-period filters and are owner-only at the API boundary. Full role-by-role production acceptance remains open. |
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
| Employee-person pay rules | IMPLEMENTED | Owner can maintain audited, non-overlapping, effective-dated employee shares for a specific employee and individual. The specific rule precedes the employee default for agency-routed base pay and dirties the settlement ledger on change. Evidence: `employee_individual_compensation_terms`, `/api/agency-financials/employee-terms`. | Rebuild and reconcile affected settlements after migration 0036 is deployed. |
| Transactions | IMPLEMENTED | Spreadsheet-like per-value filters, dates, checks, people, programs, multi-person selection, synchronized totals, row/check modes, drilldowns, and export. | Production performance, URL-length, keyboard, mobile, and first-click acceptance on a large real payroll. |
| People & Budgets | IMPLEMENTED | All individuals together; renewal as a primary field; configurable columns; with/without-budget and billing-without-budget views; authorized/used/scheduled/after-schedule/remaining hours; pace; monthly history; and safe planner hour edits. Renewal-only entry derives the annual dates. | Reconcile representative hourly, group, manual-dollar, expired, and missing-renewal records. |
| Schedule | IMPLEMENTED | Month/week/day planning; recurring schedules; employee/individual views; assignment, overlap, availability, time-off, individual clash, and budget checks before save; budget coverage; weekly availability and dated time off. New time off also produces a finance-free review queue for affected future sessions, and each action opens the exact session for rescheduling or cancellation. Evidence: `src/lib/manage/employee-availability.ts`, `src/components/schedule/employee-availability-manager.tsx`, `tests/employee-availability-management.test.ts`, `tests/schedule-availability-save.test.ts`. | Production-test time off entered before and after scheduling, partial-day overlap, recurring sessions, direct repair links, and finance-field absence with Budget Planner and Staffing Manager accounts. |
| Direct-pay employee targets | IMPLEMENTED | Authorized operators set an employee target gross, cadence, effective dates, and rate; the planner sees only derived target hours, recorded hours, scheduled hours, remaining hours, and status. Evidence: `src/lib/manage/direct-pay-operations.ts`, `src/components/schedule/direct-pay-targets-panel.tsx`. | Production-test weekly, monthly, custom, changed-rate, archived, and already-met targets. |
| Masser | IMPLEMENTED | Dedicated internal collector board, separate from Financial Setup, with imported-check confirmation, employee collections, individual set-asides, compact transaction drilldowns, statements, credits, corrections, reversals, and history. | Reconcile direct-pay, partial/extra collection, credit, correction, and renewal-boundary cases. |
| Financial Setup | IMPLEMENTED | Owner/manager configures program lines, yearly/monthly values, sequential cuts, adjustments, and the approved final amount, visually separate from Masser. | Reconcile spreadsheet examples and retain owner/manager-only access. |
| Settlement Ledger | IMPLEMENTED | Auditable obligations, payments, multi-select completion, partials, extras/credits, corrections, and reversals for both payment directions. | Production-reconcile ledger freshness and correction chains after every deal/rule type. |
| Employees | IMPLEMENTED | Financial roles see activity, people served, programs, transactions, arrangements, and checks; planning roles receive the separate finance-free directory/detail and availability/assignment workflow. | Verify both variants with representative accounts and inspect server responses for forbidden fields. |
| Reports | IMPLEMENTED | Decision-oriented reports for canonical budget use, exceptions/renewals, actual versus scheduled, program totals, funder/base/spread, employee pay, reconciliation gaps, group activity, setup audit, aliases, and audit history. Actuals come from transactions; program totals separate credited individual hours from physical employee hours. User-entered CSV text is neutralized across shared, report, and portal exports while typed negative numbers remain numeric. | Reconcile filters/totals/exports in production and repair legacy group links where exact physical-hour deduplication is required. |
| Programs | IMPLEMENTED | Reusable global programs support authorization basis, service category, group rules, payment recipient, consumption source, rate scope, renewal policy, standard rates, and individual overrides. A guided form asks the four everyday questions first, keeps rare rules collapsed, derives a short code when omitted, and atomically creates the catalog entry, operating rules, and optional starting rate. | Production-test the common create-program path with a new administrator and reconcile the first assigned authorization. |
| Classes | IMPLEMENTED | Per-individual annual dollar allowance; editable monthly invoice draft; default 22 non-Saturday service dates; atomic issue/void; budget consumption/reversal; cover-sheet attestation; and saved output. | Obtain stakeholder approval for exact branding/signature treatment and visually compare supplied examples. |
| Documents and current PDF editor | IMPLEMENTED | Private PDF library, access-gated streaming, upload, search, archive, immutable save/restore history, drafts, forms, signatures, drawing, page operations, native/OCR text inspection, cover-and-replacement text, imported fonts, and export. Saved versions reopen the retained source PDF and restore editable overlays, forms, page order/rotation, images, fonts, and export mode instead of reopening only a flattened copy; bounded embedded assets retain editable portability. Structured saves validate every page, overlay, form value, asset, ID, size, and reference before storage access while retaining pre-manifest legacy drafts. Missing Blob configuration fails before reserving unusable records. | Verify production Blob upload/edit/save/reopen/second-save/restore/archive and font embedding end to end. |
| User and agency provisioning | IMPLEMENTED | Simple role/profile chooser, generated temporary password, atomic user plus individual/employee/agency binding, preset access, agency roster dates/responsibility, and agency/per-member capability overrides. Office Manager and custom staff profiles remain available for internal exceptions. | Create every listed preset/profile once in production; verify rollback on invalid bindings and direct login after provisioning. |
| Sign In As | IMPLEMENTED | An admin can start a server-authorized session as another active user from user administration, sees a persistent banner, can explicitly return, and cannot chain previews. Central audit records retain the owner as the actor and the previewed account as the target; failed start/stop transitions fail closed and remain visible. Evidence: `src/app/api/auth/impersonation/*`, `src/lib/auth/audit-attribution.ts`, `src/components/auth/impersonation-bar.tsx`. | Production-test cookie/security behavior and every preset. Final role acceptance must also include a direct login, not only impersonation. |
| Portal statements and trends | IMPLEMENTED | Individual/parent portal supports selected-month detail, a twelve-month default trend (bounded to 24), capability-gated categories, printable statement, and CSV download without employee/check/tax/gross/net leakage. Agency and employee portals expose only granted detail. | Verify empty months, renewal boundaries, downloads, print layout, mobile layout, and category denials in production. |
| Imports, reconciliation, and matching | IMPLEMENTED | Upload/stage/review/commit, duplicate recognition, correction routes, alias decisions, person merges, and payroll-check review exist; actual transaction visibility does not depend on creating a deal for each import. Workbook parsing is field-aware, including recovery of numeric payroll amounts that Excel tagged as date cells. The supplied payroll workbook now parses 5,307 valid rows with zero invalid rows and restores 26 previously blank net-pay values. | Commit the original workbooks in production, confirm unmatched/invalid rows lead to the exact repair screen, and reconcile post-commit totals and repeated check-number identities. |
| Actionable errors and first-click UX | IMPLEMENTED | Global route-progress feedback covers internal links and native forms; shared mutation controls disable and acknowledge submits while retaining entered work and visible failures; every client component that writes through `fetch` is audited for busy and error paths; server-load failures provide a plain-language retry; and high-use import, transaction, group, collection, financial, schedule-conflict, and role-denial states link to the exact next record or repair screen. A denied redirect now explains that access was blocked after the role-specific home reload, and budget-status failures remain visible without discarding the edit. Evidence: `src/components/app-nav.tsx`, `src/components/auth/access-notice.tsx`, `src/components/manage/client.tsx`, `src/components/ui.tsx`, `tests/workflow-clarity.test.ts`, `tests/transaction-cross-drills.test.ts`, `tests/collections-deep-links.test.ts`. | Complete signed-in first-click and mobile acceptance for every preset in production. |
| Google Sheet update button | EXTERNAL BLOCKER | The button reports push and pull separately, preserves failed/unmatched Paid-marker changes, pulls rows, commits valid data, and refreshes visible results. General source cells intentionally remain read-only. | Production write-back credentials are absent. Configure the service account and verify a real Paid marker push, pull, idempotent retry, and failure recovery. |
| Adobe-class source-text PDF editing | EXTERNAL BLOCKER | The current editor is an overlay/form/document editor, not arbitrary reflow of existing source text in proprietary embedded fonts. | Choose and license a commercial source-text PDF SDK, integrate it, and verify embedded-font fidelity on the supplied PDFs; otherwise narrow the product promise to the implemented overlay editor. |

## External Dependencies And Known Limits

| Dependency or limitation | Gate |
| --- | --- |
| Google Sheet write-back | Service-account credentials and a real production Paid-marker round trip. |
| Adobe-equivalent source-text editing | Licensed SDK/product decision; the current overlay editor cannot truthfully be called Adobe-equivalent. |
| Legacy unlinked group history | Repair or backfill session links before historical physical employee hours can be exactly deduplicated. |
| Production document storage | Connected private Blob configuration and access-control acceptance. |
| Class PDF identity | Owner approval of exact logo, brand marks, signatures, and final rendered examples. |
| Historical approved set-asides | Saved setup revisions provide as-of values from August 2026 forward. Earlier months without trustworthy snapshots remain disclosed and excluded until source history is supplied. |
| Dedicated test database | Configure `TEST_DATABASE_URL` and run the 31 database integration files that are intentionally skipped without it. |

## Remaining Delivery Order

1. Deploy the stable commit and confirm its exact SHA, all 38 migrations, schema
   ledger, environment configuration, and server health before testing numbers.
2. Complete signed-in first-click, error-recovery, direct-login, Sign In As,
   desktop, and mobile acceptance for every preset in production.
3. Configure `TEST_DATABASE_URL` and run the 31 intentionally skipped database
   integration files; retain the passing unit, typecheck, build, and zero-warning
   lint evidence from this release candidate.
4. Reconcile representative production truth end to end: one normal and one
   group transaction, a renewal boundary, billing without budget, direct and
   agency-routed pay, Masser credit/correction, class invoice, manual income,
   custom split, employee-person rule, and owner agency result.
5. Configure Google write-back and private Blob, then run the real Sheet and
   document round trips. Repair legacy group links needed for exact history.
6. Create every listed preset/profile account and execute the role acceptance matrix below on
   desktop and mobile. Store screenshots/exports, inspected API payloads,
   account used, date, and pass/fail result.
7. Obtain class PDF visual approval and make the explicit Adobe SDK versus
   overlay-only product decision.

## Role-By-Role Production Acceptance

| Role/account | Daily workflow that must pass | Privacy and authority proof |
| --- | --- | --- |
| Owner | Filter a multi-person cohort; open source transactions; inspect canonical budgets; run/export reports; reconcile Agency Financials; create a user; Sign In As and return. | All agency data is available; owner-only routes reject non-admins. |
| Office Manager | Complete a normal transaction, budget, schedule, report, Masser, and financial workflow. | User administration and owner-only Agency Financials remain unavailable. |
| Budget Planner | Create/revise/cancel an hour authorization; inspect renewal/pacing/history; assign staff; enter availability; schedule within coverage; inspect hour targets. | Navigation and every API response contain no rates, dollars, transactions, payroll, checks, taxes, deals, Masser, or settlement fields. Dollar/Classes authorizations and financial mutations are rejected. |
| Staffing Manager | Find an employee, maintain availability/time off, assign them, and schedule them. | No budget or money route is reachable; employee list/detail response contains only safe identity/status data plus separate planning summaries. |
| Money Collector | Confirm an imported check; record a collection; handle partial/extra/credit; inspect corrections; produce an individual put-away statement. | No budget planning, rates, agency spread/profit report, or unrelated employee financial detail. |
| Class Billing | Add/open an allowance; build a 22-day non-Saturday invoice; issue and void it; edit/save/reopen the PDF and cover sheet. | No unrelated transactions, payroll checks, Masser, or settlements. |
| Individual / Parent | Open the linked person, change month, read 12-month trend, print and download the statement. | Cannot enumerate other people; response/export contains no employee identity, check number, tax, gross, or net fields beyond explicitly allowed aggregates. |
| Employee | Review every verified direct check in a month, allowed gross/net/tax, direct services, give-back due, payments, and balance. | Only the linked employee appears; denied categories are absent; agency-routed activity is excluded. |
| Agency / Provider | Review dated roster, program/person rollups, granted financials, and permitted employee check drilldowns; change one member override as owner and recheck. | Out-of-roster dates/people and denied member categories are absent from server responses. |
| Agency Scheduler | Assign and schedule the agency's in-scope roster and inspect hours. | No money, budgets beyond allowed hour coverage, transactions, or out-of-agency people. |
| Agency Staffing Manager | Review agency employees, availability, assignments, and schedule. | No money and no employees outside the dated agency roster. |
| Agency Collector | Review only granted agency direct-check, agency-paid, set-aside, and settlement details. | Read-only; no budget planning, internal global Masser, deal editing, or denied financial category. |

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

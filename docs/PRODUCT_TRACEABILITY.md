# Ahivim Product Traceability

This document is the implementation contract for the agency operating system.
It maps the owner's full product vision to one status, one canonical source of
truth, and one acceptance test. A feature is not complete because a page exists.
It is complete only when the intended role can finish the real workflow without
seeing information that role should not receive.

Status values:

- `COMPLETE`: implemented and covered by focused tests.
- `PARTIAL`: meaningful implementation exists, but the workflow is unfinished.
- `MISSING`: the requested workflow does not exist.
- `WRONG`: the current behavior contradicts the product vision.

## Canonical Business Truths

| Area | Status | Canonical rule | Remaining acceptance work |
| --- | --- | --- | --- |
| Transactions | COMPLETE | Committed payroll transactions are the historical truth for actual dates, checks, people, programs, hours, billed amounts, employee base, and agency spread. | Production smoke-test Sheet filters, selected-person totals, exports, and the new compact check/date/payee drilldowns. |
| Budget utilization | COMPLETE | Authorized hours are compared with transaction-backed actual hours and unmatched scheduled hours inside the authorization period. Owner summaries, utilization, outliers, renewals, and detail pages all use `program_budget_balances`. | Reconcile the canonical totals against production data after deployment. |
| Group services | COMPLETE | Physical hours are credited in full to each individual; money is allocated once across the group. | Present recognized group-rate differences as context, not a generic error. |
| Funder and employee rates | COMPLETE | A funder rate such as $25 and an employee base such as $21 remain separate. Taxes do not explain or change that rate relationship. | Keep rate setup in an advanced section and retain transaction-level explanation links. |
| Direct employee give-back | COMPLETE | The configured percentage is applied once to the whole verified check NET, never gross, hourly values, or each transaction row. Imported direct checks enter a visible confirmation queue before obligations are created. | Production-test imported mixed-recipient checks and conflicting NET values. |
| Individual cuts and put-away | COMPLETE | First and second cuts are sequential. The approved final amount is the reserve target; explanatory cuts do not create duplicate obligations. Monthly statements show target, posted amount, corrections, credit, remaining balance, and history without employee identity. | Production-reconcile one renewal boundary and one correction chain. |
| Agency-routed pay | COMPLETE | Agency-paid employee value and agency spread remain separate from direct-pay give-back. | Production-test mixed routing where the same employee and check period contains separate agency and direct recipients. |

## Role And Portal Matrix

| Preset role | Status | Required home and boundary | Remaining acceptance work |
| --- | --- | --- | --- |
| Owner | PARTIAL | Whole-agency dashboard, all reports, all people, all money, all settings, exact drilldowns, and one-step Owner provisioning. | Add multi-person cohorts and saved views; production-reconcile the owner figures and exports. |
| Budget Planner | COMPLETE | Budget portfolio, assignments, employee availability, and calendar using hours only. No transactions, rates, billed dollars, payroll, taxes, employee financials, or Masser. | Run one signed-in production acceptance after assigning the preset. |
| Staffing Manager | COMPLETE | Employee directory, availability, assignments, and scheduling without budgets or financial information. | Run one signed-in production acceptance after assigning the preset. |
| Money Collector | COMPLETE | Masser: direct checks to confirm, amount due, collections, balances/credits, individual put-away, and statements. No budget amounts or budget planning. | Production-reconcile imported checks, one collection, and one individual statement. |
| Class Billing | COMPLETE | Class allowances, invoices, cover sheets, and saved documents. | Visually compare generated PDFs with the supplied invoice and cover-sheet examples. |
| Individual / Parent | PARTIAL | Only the linked individual's approved hours, per-program use, selected-month allowed financial aggregates, and privacy-safe statements. No employee identity, employee checks, or taxes. Provisioning is one atomic step. | Add a multi-month trend and downloadable portal statement. |
| Employee | COMPLETE | Only the linked employee's verified direct checks, give-back, payments, balance, and direct-pay service history. Agency-routed activity is excluded. Provisioning is one atomic step. | Production-test one employee account against a mixed-routing check. |
| Agency / Provider | PARTIAL | Scoped rollups and program drilldowns for the agency's dated individual and/or employee roster, provisioned in one step. | Add per-member visibility overrides and check-by-check agency employee drilldowns. |
| Agency Scheduler | COMPLETE | Agency-scoped assignments and schedules using hours only, provisioned in one step. | Run one signed-in production acceptance. |
| Agency Collector | PARTIAL | Read-only agency financial summary according to explicit visibility, provisioned in one step. | Add check-by-check statement drilldowns; keep it distinct from internal Money Collector. |

## Operational Workspaces

| Workspace | Status | What the user must be able to do | Remaining acceptance work |
| --- | --- | --- | --- |
| Owner Home | PARTIAL | See what happened, canonical budget position, money position, latest payroll, and compact drilldowns. Actual activity filters by check date, person, employee, and payroll period. | Add multi-select cohorts and saved views. |
| Transactions | COMPLETE | Filter every field by values, dates, people, checks, and programs; select multiple people; keep totals synchronized; export; switch between rows and checks. | Production performance and one-click interaction test. |
| People & Budgets | COMPLETE | See all individuals together, billing without a managed budget, renewal date, authorized/used/scheduled/remaining hours, pace, history, configurable columns, and hours-only planner editing. | Production-reconcile representative hourly and group programs. |
| Schedule | COMPLETE | Plan employee and individual sessions in month/week/day views; compare planned and used hours; manage recurring weekly availability and dated time off; detect assignment, overlap, availability, and over-budget risk again at save time. | Add a retroactive queue when new time off conflicts with sessions that were already saved. |
| Masser | COMPLETE | Dedicated collector board for employee collections and individual put-away, separate from Financial Setup, with imported-check confirmation, record actions, compact transaction drilldowns, statements, history, credits, and corrections. | Production-reconcile representative direct-pay and renewal-boundary cases. |
| Financial Setup | COMPLETE | Configure expected annual/monthly values, program lines, sequential cuts, adjustments, and approved final. | Keep it owner/manager only and visually separate from Masser. |
| Settlement Ledger | COMPLETE | Preserve obligations, payments, reversals, partials, credits, and corrections as an auditable ledger. | Keep this advanced; normal Masser actions should not require using it. |
| Employees | PARTIAL | See actual people served, programs, hours, transactions, arrangements, and checks according to role. | Add availability and a finance-free staffing view. |
| Programs | COMPLETE | Create global reusable programs and configure authorization basis, renewal policy, consumption source, routing, standard rates, and individual overrides. | Add a guided basic form with advanced rules collapsed. |
| Classes | COMPLETE | Track annual per-individual class allowances and atomically issue/void editable monthly invoices with no Saturday service dates. Generated invoices match the supplied 22-day structure and cover sheets retain the full attestation. | Obtain approval on exact brand marks/signature capture and freeze generated PDFs into Documents if required. |
| Documents | COMPLETE | Upload private PDFs, edit, save immutable versions, restore by appending history, search, archive, and stream only through access-gated routes. Missing Blob configuration fails before reserving unusable records. | Verify the connected production Blob end to end. |
| Google Sheet | PARTIAL | One button truthfully reports push and pull separately, preserves failed/unmatched Paid-marker changes, pulls new rows, commits valid rows, and refreshes visible data. | Production lacks Google service-account write-back credentials. Configure them and run a real Paid-marker round trip; general cells intentionally remain read-only. |

## PDF Promise

Status: `NOT MET` for Adobe-equivalent source-text editing.

The current editor is a strong PDF overlay and form editor: native/OCR text
inspection, cover-and-replacement text, imported fonts, forms, signatures,
drawing, page operations, undo/redo, export, drafts, and version history. It
does not reflow arbitrary existing source text in proprietary embedded fonts the
way a licensed Adobe-class SDK does.

Completion requires one explicit product decision:

1. License and integrate a commercial source-text PDF SDK, then verify real
   existing-text replacement and embedded-font fidelity on the supplied PDFs.
2. Keep the current overlay editor and narrow the promise in the product copy.

Until that decision and implementation are complete, this item remains open.

## Active Delivery Order

1. Build, deploy, and apply the availability migration in production.
2. Reconcile Owner, Budget, Transaction, Masser, and group-hour totals against production data.
3. Run desktop/mobile first-click, actionable-error, and signed-in route acceptance.
4. Configure Google service-account write-back and run the real Paid-marker round trip.
5. Run private Blob upload/edit/save/reopen/restore/archive acceptance.
6. Add the remaining portal trends, agency check drilldowns, saved owner views,
   retroactive availability queue, and the chosen Adobe-class PDF SDK strategy.

## Definition Of Done

For every preset role, acceptance must prove:

- The login can be created and assigned in one flow.
- The first screen answers that role's daily questions.
- Every visible total drills into the records that created it.
- Hidden money or identity fields are absent from server responses, not merely
  hidden with CSS.
- Every problem state has one plain-language action leading to the exact fix.
- Buttons acknowledge the first click and preserve entered work on failure.
- Desktop and mobile workflows complete without overlap or clipped text.
- Production data, Sheet sync, storage, and exports are tested with the real
  integrations before the item is marked complete.

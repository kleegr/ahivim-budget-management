# Ahivim operating model

This document is the product contract for programs, budgets, payments, and portal visibility. It records the business rules that must remain true as the application evolves.

## One operational model

All services begin in the global program catalog. A program defines how authorization is measured, how use is recorded, who receives payment, and whether the default rate may be overridden for an individual. An individual then receives a dated authorization for that program. Hourly services, annual allowances, classes, and future service types all use this same authorization model.

The source systems may differ, but balances do not:

- Payroll-backed services derive usage from committed transactions.
- A payroll transaction's canonical service date is period begin, then check date, then period end. Import timestamps are never service dates; rows with none of those dates are excluded from consumption and flagged for review.
- Invoice-backed services post usage when an invoice is issued and reverse it when that invoice is voided.
- Manual services use an append-only event with a reason and actor.
- Drafts and planned schedules never consume a financial authorization.
- A source is represented once. Payroll usage is not copied into the manual event ledger.

Classes uses the same canonical authorization and balance read model, but the Classes invoice workflow is its sole writer. Generic program endpoints cannot create, revise, cancel, adjust, or reverse a Classes allowance; this prevents the class ledger and its linked authorization from diverging.

Every authorization has an explicit start and end date. Renewal is a new period, not a destructive reset of history.

## Rates and recipients

The funder or agency rate and the employee or internal rate are different values. For example, a funder rate of 25 and an employee rate of 21 means the employee-side service value is 21; the difference is agency spread. Receiving 25 never changes the employee rate to 25. Taxes do not change either program rate.

A program rate schedule supplies both catalog defaults. A dated authorization snapshots its effective funder rate in `agency_rate` and its effective employee rate in `internal_rate`. When the program permits individual rate overrides, a different employee rate is also identified in `individual_rate_override`; an individual-specific funder rate remains a separate `agency_rate` value. When overrides are disabled, both authorization rates must match the catalog defaults. Revising a rate supersedes the authorization and creates a new revision, so prior rates and transactions are never rewritten.

A program declares whether payment is routed to the agency or directly to the employee. Rate visibility follows the money category: funder rates require billed-amount access, employee rates require employee-amount access, and planners receive neither.

## Individual allocations

Individual allocation rules belong to the individual, even when employee transactions are the calculation source. The first percentage applies to the gross basis. The second percentage applies to the remainder after the first. Adjustments are applied after those steps according to the saved strategy.

Individual and parent portals show aggregate billed amounts and aggregate set-asides by period. They never identify employees or expose employee taxes, checks, deal terms, or collections.

## Employee direct pay

Direct-pay give-back rules belong to the employee deal and are separate from individual allocation rules. The percentage applies to the whole check net, not an hourly value and not gross pay. Gross and net are used to show withholding; taxes do not enter the give-back formula.

A manually entered payroll check is authoritative only after it is marked Verified. An Unverified check stays visible in the operator review queue but does not change portal totals or generate a give-back obligation. Marking a previously verified check Unverified or Void causes the append-only settlement reconciliation to correct the derived obligation; it never rewrites collection history.

Transactions routed to the agency are not direct-pay checks. They remain a separate payable flow and must never be silently netted against employee give-back receivables.

## Settlement ledger

Generated obligations are immutable calculation records. Payments, collections, credits, refunds, and set-asides are append-only events. Corrections reverse an event and add the corrected event. Every screen derives remaining balance from the original obligation and signed events.

## Roles and minimum visibility

The security role controls administrative power. The portal role controls the experience and default visibility. A user may have multiple scoped relationships, but external access never expands through connected people.

Internal workspaces and external agency portals are deliberately different. Ahivim's internal Planner profile may create and change schedules in the hours-only Planning workspace. Ahivim's internal Money Collector may record checks, collections, and set-asides in Masser. Agency portal roles named Scheduler, Staffing manager, or Collector receive only scoped reports for their agency; those labels do not grant access to the internal Planning or Masser write endpoints. An internal staff account must be assigned the corresponding internal access profile separately.

| Portal role | Primary work | Money visibility | People scope |
| --- | --- | --- | --- |
| Owner | Portfolio health, exceptions, configuration | All categories | Entire organization |
| Operations | Imports, review, billing operations | Explicit capabilities | Assigned organization scope |
| Internal Planner | Create schedules; compare assigned, authorized, actual, and remaining hours | None | Full planning roster |
| Internal Staffing | Employee availability and assignments | Optional target status only | Assigned employees and individuals |
| Internal Money operator | Record checks, collections, credits, and set-asides | Explicit collection categories | Assigned collection portfolio |
| Individual / guardian | Own program use, balance, and aggregate set-asides | Portal-approved aggregates | Directly linked individuals only |
| Employee | Own direct checks, gross/net/withholding, give-back, and balance | Own approved categories | Directly linked employee only |
| Agency | Approved rollups for linked individuals and/or employees | Per-agency visibility policy | Explicit agency memberships only |
| Agency scheduler / staffing / collector | Read-only scoped schedule, hours, or financial summaries | Role-limited report categories | Explicit agency memberships only |

Viewing a settlement and changing the settlement ledger are separate permissions. External portals use dedicated read models; they do not reuse internal person pages or connected-set expansion.

## Planner targets

The planner never sees rates, dollar budgets, payroll transactions, net pay, taxes, deals, or settlement amounts. Planning is expressed in authorized, actual, scheduled, and remaining hours.

An employee may have a direct-pay work target such as a weekly gross target. The financial value remains private. The planner receives only an operational status and the hours still needed for eligible direct-pay programs, calculated from authorized program rates by the server. The calendar must prevent conflicts, show uncovered authorizations, and distinguish actual work from future schedules.

## PDF editing

The document workspace supports page reordering, deletion, rotation, AcroForm filling, signatures and marks, OCR-assisted placement, cover-and-replacement text layers, and verified export. Unchanged form appearances are preserved; changed fields reuse a recoverable source Base-14 font and disclose when Helvetica fallback is necessary. High-fidelity export is the default, while transformations that cannot safely preserve interactive structure force a sanitized export with the reason shown before download.

Cover-and-replacement text is a new visual layer and is never described as editing or reflowing the source text object. Arbitrary semantic source-text reflow with proprietary embedded fonts is outside the custom engine and requires a separately licensed commercial PDF SDK.

## Invariants

- Money and hours use decimal arithmetic and database numeric values, never JavaScript floating-point arithmetic.
- Every effective-dated rule preserves prior history.
- Overlap checks for an individual's program authorizations are serialized before activation.
- A ledger reversal exactly negates its source event, including a negative adjustment whose reversal is positive.
- Group sessions store physical employee time once, credit each participant with full service hours, and divide money explicitly.
- Saturday is excluded from generated class service dates.
- Issuing or voiding an invoice and changing its authorization balance occur in one database transaction.
- A portal response contains only fields that role is permitted to see; hiding a column in the browser is not authorization.

# Ahivim Agency Operating System

## Plain-Language Product Specification

**Document purpose:** Define the complete product the agency is building, the business rules it must preserve, what each user is allowed to see and do, and the standard for calling the system complete.

**Status basis:** This specification reflects the owner's full product vision and the current repository as of September 1, 2026. Product intent and current implementation status are intentionally separated. A feature described here is not automatically production-verified merely because a page or code path exists.

---

## Executive Summary

Ahivim is the agency's complete operating system. It replaces disconnected spreadsheets, calendars, calculation sheets, payment lists, class invoices, and PDF files with one connected source of truth. It is not only a budget tracker and not only a CRM. It manages the relationships and daily work among individuals, parents, employees, agencies, programs, transactions, budgets, schedules, financial arrangements, collections, classes, documents, and users.

The whole operating system and the role-specific portals use the same records. The owner sees the complete agency. Internal staff receive the workspace needed for their job. Individuals, parents, employees, and outside agencies receive restricted portals. A portal is not a second copy of the business data. It is a server-enforced view of the shared truth, with forbidden people and financial categories removed before the response is sent.

Three truths must stay distinct. **Transactions** show what actually happened. **Budgets** show what was authorized, used, scheduled, and remains before renewal. **Financial Setup and Masser** define and execute what must be collected, paid, or put away. Schedules are plans, not actuals. Reports connect these truths but must never quietly replace one with another.

The owner needs a whole-agency Home, multi-person filtered totals, exact source drilldowns, every report, every person and agency, all financial setup, user administration, and a secure **Sign In As** preview. The preview reloads the system as the selected user and leaves only a small return control, allowing the owner to confirm access before sharing a login.

The Budget Planner is governed by an absolute no-money rule. The planner can see authorized, actual, scheduled, and remaining hours; renewal, pace, assignments, availability, and the calendar. The planner cannot receive dollars, rates, transactions, payroll, checks, taxes, employee deals, Masser, or settlement data. The Staffing Manager receives an even narrower employee, availability, assignment, and schedule experience without budgets or finance. The Money Collector works in Masser with verified checks, give-back, collections, credits, individual put-away, corrections, and statements, but does not receive budget planning or the owner's profit report.

The financial model keeps **Funder billed**, **Employee base**, and **Agency spread** separate. A $25 funder rate does not become $25 employee pay when the employee base is $21. Sequential individual cuts are applied one after another, but only the approved final monthly amount is the set-aside expense. Taxes are verified check gross minus net and remain separate from give-back. Direct-pay give-back applies once to the whole verified check net. Agency-routed employee share applies to Employee base, never Funder billed. The owner Agency Financials report uses only actual transaction income and explicitly recorded actual receipts, not projected budgets or uncollected invoices.

Scheduling is a daily operating workspace with month, week, and day views, recurring visits, availability, time off, assignments, conflicts, budget coverage, pace, and recorded-service matching. Exact daily facts may connect automatically, but pay-period aggregates and groups remain for human review. One recorded transaction cannot belong to two planned visits.

Classes use per-individual annual dollar allowances, editable monthly invoices, up to 22 default non-Saturday service dates, issue/void history, cover sheets, and saved documents. Issuing an invoice consumes the allowance but does not count as received cash. Actual class income is recorded when payment is received.

The private document library and current PDF editor support forms, signatures, drawing, page operations, OCR-assisted placement, overlays, versions, restore, and export. They do not yet provide truthful Adobe-equivalent arbitrary source-text reflow with proprietary embedded fonts. That promise requires selection, licensing, integration, and production verification of a commercial PDF SDK.

The current repository implements most of this operating model, but no full product area is yet classified as production verified. Role-by-role direct login, mobile acceptance, real-data reconciliation, database integration tests, Sheet write-back credentials, full document round trips, class branding approval, and the commercial PDF decision remain open. The honest status and delivery gates are recorded in Appendix A.

## Table of Contents

1. [Product Definition](#1-product-definition)
2. [Product Principles](#2-product-principles)
3. [Canonical Business Truths](#3-canonical-business-truths)
4. [Core Records and Relationships](#4-core-records-and-relationships)
5. [Users, Roles, and Exact Privacy Boundaries](#5-users-roles-and-exact-privacy-boundaries)
6. [Owner Sign In As](#6-owner-sign-in-as)
7. [Page and Workspace Catalog](#7-page-and-workspace-catalog)
8. [Individuals, Employees, Agencies, and Programs in Practice](#8-individuals-employees-agencies-and-programs-in-practice)
9. [Scheduling, Calendar, and Availability](#9-scheduling-calendar-and-availability)
10. [Google Sheet Sync and Transaction Control](#10-google-sheet-sync-and-transaction-control)
11. [Budgets, Renewal, Pace, and History](#11-budgets-renewal-pace-and-history)
12. [Financial Rules and Owner Agency Financials](#12-financial-rules-and-owner-agency-financials)
13. [Masser and the Payment Ledger](#13-masser-and-the-payment-ledger)
14. [Custom Programs, Classes, and Invoices](#14-custom-programs-classes-and-invoices)
15. [Document Library and PDF Editor](#15-document-library-and-pdf-editor)
16. [Reports](#16-reports)
17. [Errors, Review States, and Action Handling](#17-errors-review-states-and-action-handling)
18. [Permissions, Audit, and Security](#18-permissions-audit-and-security)
19. [User Experience Standard](#19-user-experience-standard)
20. [Product Success Criteria](#20-product-success-criteria)
21. [Appendix A: Current Implementation and Delivery Status](#appendix-a-current-implementation-and-delivery-status)
22. [Appendix B: Production Acceptance Record](#appendix-b-production-acceptance-record)

---

## 1. Product Definition

Ahivim is the operating system for the agency. It replaces the collection of Google Sheets, Excel workbooks, manual calculations, calendars, payment lists, class invoices, and edited PDF forms that have been used to run the business.

It is broader than a budget application and broader than a CRM. It connects:

- Individuals receiving services
- Parents and guardians
- Employees providing services
- Outside agencies and providers
- Programs and rates
- Authorized budgets
- Actual billing and payroll transactions
- Employee availability and scheduling
- Employee payment arrangements
- Individual cuts and money put away
- Collections, payments, credits, and corrections
- Classes, invoices, and cover sheets
- Documents and PDF editing
- Reports, audit history, and user access

The product must answer the agency's daily questions without requiring spreadsheet expertise:

- What actually happened?
- What budget is available?
- What has been used and what remains?
- Is the budget on pace before renewal?
- Who worked with whom?
- What is planned next?
- What money came in?
- What does the employee keep, owe, or need to receive?
- What must be put away for the individual?
- What has already been collected or paid?
- What still needs action?
- Why is this number here, and which records created it?

### 1.1 The operating system and the portals are not separate systems

There is one shared operating system with one set of canonical records. A portal is a role-specific window into those records.

- The **owner workspace** is the full agency control center.
- **Internal staff workspaces** support jobs such as planning, staffing, collecting money, and class billing.
- **External portals** let an individual, parent, employee, or agency see only their own approved information.
- A portal must never calculate a competing version of the same number.
- Hiding a column in the browser is not privacy. Forbidden data must be absent from the server response.
- A user may have more than one relationship, but one relationship must never silently expand access through another connected person.

The same transaction can therefore support several correct views without exposing the same details to everyone. The owner may see the complete transaction and financial result. The planner may see only the hours. The individual may see an approved aggregate without employee identity. The employee may see only the verified direct check connected to that employee.

---

## 2. Product Principles

### 2.1 Simplicity before feature density

The business is complicated; the interface must make it feel simpler. Advanced controls may exist, but the everyday path must be obvious to a new, nontechnical user.

Each screen should answer one primary question. A normal user should not have to understand imports, database terms, rule engines, or internal calculations to finish a task.

### 2.2 Actuals, plans, and setup must stay distinct

- **Transactions** say what actually happened.
- **Budgets** say what was authorized and what remains.
- **Schedules** say what is planned for the future.
- **Financial Setup** says how cuts, rates, and approved monthly amounts should be calculated.
- **Masser and the Payment Ledger** say what must be collected, paid, or put away and what has actually been done.

These areas are connected, but their numbers must not be mixed or mislabeled.

### 2.3 Every important total must explain itself

A total such as 137 billed hours or $4,763.20 agency spread must lead to the exact underlying records that produced it. Filters, exports, drilldowns, and dashboard cards must use the same definition.

### 2.4 No guessed money

If a rate, check, deal, split, or historical setup is missing, the system must disclose the gap and exclude the uncertain amount. It must not silently substitute a convenient assumption.

### 2.5 History is preserved

Transactions, authorizations, rates, deals, roster relationships, financial setups, and corrections are dated. A new rule supersedes the old rule; it does not rewrite prior history.

### 2.6 Problems lead directly to actions

An error or exception is useful only when the user can open the exact record that needs repair. The system should not create reminder clutter for ordinary missing setup. It should show a clear review state and one direct next action.

### 2.7 The first click must feel immediate

Navigation and action buttons must respond on the first normal click, show progress, prevent duplicate submission, retain entered work after a failure, and give a plain-language result.

### 2.8 Privacy is part of the calculation

Every read model, report, download, and API response must apply the user's role, relationships, grants, denials, and date scope before returning data.

---

## 3. Canonical Business Truths

### 3.1 Transactions: what actually happened

Committed payroll transactions are the historical truth for billed activity. They contain the source dates, check, program, individual, employee, hours, rates, amounts, payment recipient, and source references.

Each transaction keeps its own dates. Rule effective dates decide which setup applied; they do not replace the transaction date.

For service-based actuals, the canonical service date is selected in this order:

1. Period begin
2. Check date
3. Period end

Rows with no usable service date are disclosed for review and must not silently consume a budget.

Payroll and service reporting may use different time bases. A check-date payroll total and a service-month financial total can both be correct while containing different records. Every report must state its time basis.

### 3.2 Budgets: what was authorized versus what was used

An individual can have one or more programs, each with its own dated authorization.

For hourly programs:

- Authorized hours come from the active authorization.
- Used hours come from committed transactions during that authorization period.
- Scheduled hours are future plans and are shown separately.
- Remaining after schedule equals authorized minus used minus eligible scheduled hours.
- A known renewal date defines the next renewal. The current annual authorization normally runs for the prior 12 months and ends the day before renewal.
- Renewal creates a new period. It never erases the prior period.

For dollar allowances and manually consumed programs, the same authorized, used, and remaining concept applies, but usage comes from the program's declared source, such as an issued class invoice or an audited manual event.

### 3.3 Financial Setup: how the arrangement is defined

Financial Setup belongs to the individual's account arrangement. It contains program hours and rates, yearly and monthly values, sequential cuts, adjustments, and the approved final monthly amount to put away.

Financial Setup explains the calculation. It does not by itself prove that money was collected, paid, or put away.

### 3.4 Masser and the settlement record: what must be actioned

Masser is the internal money-operations workspace used by the collector. It turns approved rules and verified actuals into trackable obligations and events:

- What the employee owes back to the agency
- What the agency owes an employee
- What must be put away for an individual
- What was collected, paid, credited, corrected, reversed, or remains open

The approved final monthly individual amount is the set-aside obligation. The first and second cuts explain how that amount was reached; they do not create additional duplicate expenses.

### 3.5 Scheduling: what is planned

Scheduled visits are future operational plans. A schedule does not become an actual transaction merely because it exists. It must be compared with recorded transactions so the agency can see planned-not-recorded and recorded-not-planned work.

### 3.6 Group services

Group activity must not be mistaken for an hourly-rate error.

- Each participating individual receives the full credited service hours.
- The employee's physical work time is counted once for the linked group session.
- Money is allocated explicitly among the individuals.
- Combined group rates may be multiples of the base rate.
- Funder billed, employee base, and agency spread remain distinct at the transaction level.
- Legacy group rows without a reliable service-session link must disclose that exact physical-time deduplication is unavailable.

---

## 4. Core Records and Relationships

### 4.1 Individual

The person receiving services. An individual record can connect to:

- Parents or guardians
- Programs and dated authorizations
- Renewal dates
- Actual transactions
- Employees who actually worked with the person
- Assigned employees and future schedules
- Financial Setup
- Monthly set-asides and Masser statements
- Class allowances and invoices
- Agency roster relationships
- Documents and notes according to permission

An individual may be billed by an agency that does not manage the budget. The system must distinguish **budget responsibility**, **billing responsibility**, **both**, and **roster only**.

### 4.2 Employee

The person providing services. An employee record can connect to:

- Individuals actually served
- Programs worked
- Actual transactions
- Direct-pay or agency-routed payment
- Verified payroll checks
- Effective-dated employee deals
- Employee-plus-individual compensation terms
- Give-back obligations or agency payables
- Collections and payments
- Availability, time off, assignments, and schedules
- Agency roster relationships

Financial and planning users receive different employee views. The planning view must not reuse a financial employee payload.

### 4.3 Agency or provider

An agency may be responsible for multiple individuals, multiple employees, or both. Agency membership is dated and may carry different responsibilities and visibility rules per member.

The agency profile must support:

- Roster and responsibility
- Individuals and programs in scope
- Employees in scope
- Hours and schedule categories
- Granted financial rollups
- Per-member grants and denials
- Check drilldowns only when the source can be uniquely scoped to that agency

When an exact agency-scoped source link cannot be represented, the interface must not link to a broader person-wide ledger and imply that it matches the agency total.

### 4.4 Program

Programs are created once in a global catalog and assigned to individuals as needed. A program defines:

- Name and short code
- Hourly, dollar, or other authorization basis
- Service category
- Whether group service is allowed
- Whether payment goes to the employee or the agency
- Which source consumes the authorization
- Renewal policy
- Default funder and employee-base rates
- Whether rates can vary by individual
- Whether the agency receives a rate different from the displayed employee-side rate

Rare configuration should remain available without overwhelming the common create-program flow.

### 4.5 Transaction

A committed source row representing recorded activity. Transactions are never projections. They retain source values even when a correction, alias decision, or rate review is required.

### 4.6 Authorization

A dated amount of hours or dollars made available to one individual for one program. Revisions preserve history and overlapping active periods are prevented.

### 4.7 Payroll check

A check-level record with gross, net, date, and employee. Repeated net values across transaction rows count once per check. An imported or manually entered check must be verified before it changes portal totals or creates a give-back obligation.

### 4.8 Obligation and event

An obligation records what is due. Events record what was actually collected, paid, credited, refunded, corrected, reversed, or put away. Corrections reverse the old event and add the corrected event instead of rewriting history.

---

## 5. Users, Roles, and Exact Privacy Boundaries

The product has two related layers of access:

- The **security role** controls administrative authority.
- The **portal or access profile** controls the experience, categories, and people the user may see.

Preset profiles make normal user creation simple. Custom grants and denials remain available for exceptions.

The current simple presets are **Owner**, **Budget planner**, **Staffing manager**, **Money collector**, **Class billing**, **Individual or parent**, **Employee**, **Agency**, **Agency scheduler**, **Agency staffing manager**, and **Agency collector**. **Office manager** is available as an internal manager profile, and **Custom access** handles an exception that does not fit a normal preset. The user-creation experience should present these as business choices rather than asking the owner to assemble technical permissions first.

### 5.1 Owner

**Purpose:** Oversee the whole agency and move between every business perspective.

**Can see and do:**

- Whole-agency Home and actual financial result
- All individuals, employees, agencies, programs, transactions, budgets, schedules, Masser, settlements, classes, documents, reports, and settings
- Multi-person cohorts with totals that follow all filters
- User creation, role assignment, scoped access, grants, and denials
- Sign In As another active user
- Owner-only Agency Financials and exports
- Configuration of rates, deals, splits, and financial setup

**Privacy boundary:** Owner has full agency access. Owner-only routes must reject every non-owner account.

### 5.2 Office Manager

**Purpose:** Complete broad everyday internal operations without controlling owner accounts or the owner's final profit view.

**Can see and do:** Transactions, budgets, schedules, reports, normal Masser and financial workflows according to assigned access.

**Must not see or do:** User-account administration and the owner-only Agency Financials result unless the owner explicitly changes the role design in the future.

### 5.3 Budget Planner

**Purpose:** Keep every hourly budget useable and on pace before renewal.

**Can see and do:**

- Full planning roster
- Authorized, used, scheduled, after-schedule, and remaining hours
- Renewal dates, pace, monthly history, budget coverage, and billing-without-budget status
- Assignments, availability, time off, recurring schedules, and calendar planning
- Create, revise, or cancel active non-Classes hour authorizations
- Direct-pay work targets only as derived hours and operational status

**Absolute no-money rule:** The planner must never receive or see:

- Dollar amounts or dollar budgets
- Funder or employee rates
- Transaction ledger rows
- Payroll checks, gross, net, or taxes
- Employee deals
- Agency spread or profit
- Masser, collections, settlements, or manual financial adjustments

The restriction applies to navigation, pages, API responses, exports, error details, and save responses. The planner may see actual hours derived by the server without receiving the underlying financial transaction.

### 5.4 Staffing Manager

**Purpose:** Manage employees, availability, assignments, and schedules.

**Can see and do:** Finance-free employee directory and detail, status, weekly availability, dated time off, assignments, and scheduling.

**Must not see:** Budgets, rates, dollars, payroll references, transactions, checks, taxes, employee deals, settlements, Masser, or private financial notes.

### 5.5 Money Collector

**Purpose:** Collect money from employees, record payments and credits, and show individuals what was put away.

**Can see and do:**

- Masser queues
- Relevant verified checks, gross, net, and withholding
- Employee give-back due, collected, credit, and remaining
- Agency-payable employee obligations where assigned
- Individual approved monthly set-aside, recorded amount, corrections, credit, remaining, and statement history
- Partial, extra, correction, reversal, and multi-select completion workflows
- Compact source references needed to explain an obligation

**Must not see:** Budget planning, authorized budget dollars, owner agency profit, agency spread, or unrelated financial information outside the collection job.

The collector's statement for an individual shows aggregate billed and put-away information without naming employees or exposing employee checks, taxes, or deal terms.

### 5.6 Class Billing

**Purpose:** Manage class allowances, invoices, cover sheets, and supporting documents.

**Can see and do:** Individual class allowances, activities, invoice drafts, issue and void, cover sheets, generated PDFs, saved documents, and permitted PDF editing.

**Must not see:** Unrelated payroll transactions, employee checks, taxes, Masser, deals, or settlements.

### 5.7 Individual or Parent

**Purpose:** Understand the linked individual's approved services and aggregate financial position.

**Can see:** Only directly linked individuals and only granted categories, including approved hours or budgets, selected-month aggregates, money put away, remaining position, a 12-month trend, schedule when granted, and privacy-safe print or download statements.

**Must not see:** Other individuals, employee identity, employee checks, check numbers, gross, net, taxes, employee deal terms, collections from an employee, or agency profit.

### 5.8 Employee

**Purpose:** Understand the employee's own direct-pay checks and balance.

**Can see:** Only the linked employee's verified direct checks, permitted gross/net/withholding fields, direct-pay service history, give-back calculation, payments, credit, and remaining balance. Categories can be enabled or denied.

**Must not see:** Other employees, unrelated individuals, agency-routed transaction activity presented as direct pay, agency profit, individual financial setup, or denied fields.

### 5.9 Agency or Provider

**Purpose:** See approved rollups across that agency's dated roster.

**Can see:** Linked individuals and employees, program and person rollups, approved hour or dollar categories, granted financial summaries, and permitted check-level drilldowns.

**Must not see:** People outside roster dates, denied categories, the agency-wide owner result, internal user administration, or broader person activity that cannot be attributed to the selected agency.

Whole-check and give-back amounts must be hidden when an employee belongs to more than one agency unless every source transaction can be resolved uniquely to the requesting agency.

### 5.10 Agency Scheduler

**Purpose:** Schedule the agency's own in-scope roster using hours.

**Can see and do:** Agency-scoped people, authorized hour coverage, and schedule management according to the role's schedule capabilities.

**Must not see:** Money, rates, transactions, payroll, checks, taxes, deals, settlements, or out-of-agency people.

### 5.11 Agency Staffing Manager

**Purpose:** Manage the agency's employee roster, availability, assignments, and schedule.

**Can see and do:** Dated agency employee roster, safe employee status, availability, assignments, and schedules.

**Must not see:** Money, financial budgets, payroll, checks, deals, Masser, settlements, or employees outside the agency roster.

### 5.12 Agency Collector

**Purpose:** Review approved agency-scoped collection and set-aside information.

**Can see:** Read-only agency financial, direct-check, agency-paid, set-aside, and settlement categories that were explicitly granted.

**Must not see or do:** Global internal Masser, budget planning, deal editing, settlement mutation, denied categories, or records outside the agency scope.

### 5.13 Custom and overlapping access

- Per-agency and per-member grants and denials refine a preset.
- A denial wins over a grant for the same category.
- Roster start and end dates constrain agency access.
- Direct individual and employee relationships do not automatically grant access to connected people.
- Viewing the settlement ledger and changing it are separate permissions.
- External portal accounts do not inherit internal write authority merely because their role label sounds similar.

---

## 6. Owner "Sign In As"

The owner needs to verify a portal before giving a user login credentials.

The user-administration screen must provide a simple **Sign In As** action for an active user. Starting it must:

1. Create a server-authorized preview session.
2. Reload the application into exactly that user's navigation, home, fields, data scope, and actions.
3. Show only a small persistent control that says, in plain language, **Return to your portal**.
4. Prevent impersonation from being chained into another impersonation.
5. Preserve the owner as the audit actor and the previewed user as the target.
6. Fail closed if starting or ending the preview cannot be completed safely.

Sign In As is a preview and support tool. It does not replace testing a real direct login for each role.

---

## 7. Page and Workspace Catalog

### 7.1 Home

The first screen must be role-specific, calm, and actionable.

The owner Home includes:

- Actual agency activity
- Canonical budget position
- Latest payroll/check activity
- Monthly actual income, expenses, agency result, employee collections, agency payments, and individual set-asides
- Multi-person selection and named saved views
- Direct links from every total to its source

A failure in one financial section must not blank the operational overview.

Other roles land on the workspace or portal that answers their daily job, not on a smaller copy of the owner dashboard.

### 7.2 My Portal

The role-filtered home for individuals, parents, employees, and agencies. It presents only approved categories and scoped people, with selected-month detail, trends, statements, and schedule links where allowed.

### 7.3 Transactions

The complete historical ledger for authorized internal users. It supports spreadsheet-like filtering, totals, drilldowns, row and check views, saved selections, and export. See Section 10.

### 7.4 People & Budgets

The full individual portfolio, designed for scanning and repeated action. Renewal is a primary column. Users can choose relevant columns and open views for:

- With a budget
- Without a budget
- Billing without a managed budget
- Expired or missing renewal
- Behind pace, tight, or over authorization

The individual detail connects current programs, history, actual activity, schedule, assigned employees, and permitted financial setup.

### 7.5 Schedule

The working calendar for month, week, and day planning, coverage, recurring service schedules, future visits, availability, time off, operational employee targets, and recorded-service matching. See Section 9.

### 7.6 Masser

The internal collector board for checks, employee collections, individual put-away, balances, credits, statements, corrections, and history. It is intentionally separate from Financial Setup and owner Agency Financials.

### 7.7 Employees

Financial roles see permitted actual activity, people served, programs, transactions, arrangements, checks, and balances. Planning roles receive a separate finance-free directory and detail experience.

### 7.8 Agencies

The owner directory for agency/provider records, dated rosters, responsibilities, roles, category permissions, and scoped rollups. Exact agency totals must never drill into broader unscoped transactions.

### 7.9 Classes

Class allowances, monthly invoice building, activities, non-Saturday service dates, issue/void, cover-sheet attestation, and saved output.

### 7.10 Documents

A private document library and PDF editor with upload, search, version history, restore, archive, access-controlled viewing, and export. See Section 15.

### 7.11 Reports

A decision-oriented report library. Each report states the question it answers and its date basis, keeps money stages separate, and exports the same filtered rows shown on the screen.

### 7.12 Owner Agency Financials

An owner-only selected-month report using actual recorded income and the approved expense rules. It is not a projection or budget forecast. See Section 12.

### 7.13 Google Sheet

The source-refresh workspace shows configuration, a clear Sync now action, separate push and pull status, run history, conflicts, and the direct next action when attention is needed.

### 7.14 Financial Setup

The owner/manager workspace for program lines, yearly and monthly values, sequential cuts, adjustments, rate overrides, and the approved final monthly set-aside.

### 7.15 Payment Ledger

The auditable record of obligations and signed events for both directions of money: employee-to-agency collections and agency-to-employee or individual payments/set-asides.

### 7.16 Schedule Matching and Reconciliation

Shows planned visits with no exact recorded service, possible pay-period candidates, and recorded transactions with no schedule. Exact daily one-person, same-employee, same-program, same-hours records may connect automatically. Pay-period aggregates, group activity, and ambiguity remain for human review.

One recorded transaction may belong to only one planned visit.

### 7.17 Imports and Data Review

Supports workbook upload, staging, review, commit, duplicate recognition, invalid-row repair, name matching, alias decisions, person merge, group review, and import history.

Actual transaction visibility must not depend on creating a deal for every imported record. Missing optional setup is reviewed separately from successful source import.

### 7.18 Users & Settings

The owner creates users through a simple preset chooser, binds the person or agency, sets category access, generates a temporary password, and can preview the resulting portal. Settings also maintain global programs, agencies, roles, aliases, and operating configuration.

---

## 8. Individuals, Employees, Agencies, and Programs in Practice

### 8.1 A complete individual view

Opening an individual should answer, in one connected experience:

- Which programs are authorized?
- What is the active period and renewal date?
- How many hours or dollars were authorized, used, scheduled, and remain?
- Is use on pace?
- What happened each month?
- Which employees actually worked with this person?
- Which employees are assigned or scheduled next?
- Is an outside agency managing the budget, billing, both, or neither?
- What Financial Setup is active?
- What amount was approved to put away each month?
- What has actually been put away and what remains?
- Which class allowances and invoices apply?

The employees shown as actual workers must come from transactions. Assigned or scheduled employees are a separate future-facing list.

### 8.2 A complete employee view

Opening an employee for an authorized financial user should answer:

- Which individuals and programs did the employee actually work with?
- Which transactions and checks apply?
- Which payments were direct and which were routed to the agency?
- What was gross, net, and withholding on verified direct checks?
- What give-back is due, paid, credited, and remaining?
- What agency-routed employee share is due, paid, and remaining?

For staffing users, the same employee identity opens a separate safe operational view with status, availability, time off, assignments, and schedule only.

### 8.3 A complete agency view

The owner can see all agencies together and open one agency to understand:

- Dated individual and employee roster
- Budget-management and billing responsibilities
- Hours and permitted financial rollups
- Per-member permission differences
- Agency portal users and roles
- Current assignments and schedules

An agency portal sees this only for its own dated scope and approved categories.

### 8.4 Program administration

An administrator creates a program once, then assigns it to individuals. The common setup should ask four everyday questions first:

1. What is the program called?
2. Is its allowance measured in hours, dollars, or another unit?
3. Who receives the source payment: employee or agency?
4. What source consumes the allowance: payroll, class invoice, or audited manual entry?

Rates, group rules, renewal policy, and individual overrides remain available as advanced settings.

---

## 9. Scheduling, Calendar, and Availability

Scheduling is a primary daily workspace, not a decorative calendar.

### 9.1 Calendar experience

The planner must be able to:

- Switch between month, week, and day
- Filter by employee, individual, program, status, or unassigned work
- Open a person or employee from the calendar
- Create one-time and recurring schedules
- Edit or cancel future visits with an audit reason
- See group status without exposing money
- Open the exact visit from a conflict or review message
- Move naturally between coverage, availability, assignments, targets, and the calendar

### 9.2 Availability and staffing

The system supports:

- Weekly employee availability
- Dated time off and partial-day unavailability
- Employee assignments to individuals/programs
- Active-date checks against agency roster responsibility
- Review of future sessions affected by new time off
- Exact repair links to reschedule or cancel an affected visit

### 9.3 Save-time checks

Before a schedule is saved, the system checks:

- Employee overlap
- Employee availability and time off
- Individual overlap
- Assignment validity
- Agency roster scope
- Program eligibility
- Remaining budget coverage when the role is allowed to see it

A warning must explain the conflict in plain language. Permission to override, and the required reason, depend on role.

### 9.4 Budget coverage and pace

For each hourly authorization, planning shows:

- Authorized hours
- Actual recorded hours
- Future scheduled hours
- Hours remaining after schedule
- Time remaining before renewal
- Pace needed per week or month
- Status such as on track, behind, tight, over, expired, or missing renewal

The monthly history must let the planner compare delivered activity with the budget pace rather than showing only a single remaining number.

### 9.5 Direct-pay employee work targets

An authorized financial operator may set a target such as $1,000 direct-pay gross per week. The planner does not receive that amount or its rate.

The server converts the target into permitted operational facts:

- Target hours
- Recorded eligible hours
- Scheduled eligible hours
- Remaining hours
- On-track status

### 9.6 Recorded-service matching

Scheduling and transactions are connected without pretending they are identical.

- Exact daily facts may be linked automatically.
- Pay-period totals are not divided into invented daily visits.
- Group records remain group-aware.
- Ambiguous candidates remain for review.
- A failed optional matching pass does not turn a successfully committed Sheet import into a failed import.
- The failed matching range remains reviewable and is retried by a later unchanged sync.

### 9.7 Planner privacy checklist

No planner screen, response, download, error, tooltip, or link may expose a dollar sign, rate, check, gross, net, tax, give-back amount, agency spread, financial setup percentage, or settlement balance.

---

## 10. Google Sheet Sync and Transaction Control

### 10.1 Source relationship

The Google Sheet remains the source feed for actual payroll/billing transactions until the business changes that process. Sync uses the same staging, matching, group detection, rate logic, duplicate protection, and audit rules as workbook import.

### 10.2 The update button

The workspace provides one clear **Sync now** action. A full configured round trip:

1. Pushes eligible pending Paid-marker changes to the Sheet.
2. Pulls the latest Sheet rows.
3. Stages and commits genuinely new valid transactions.
4. Leaves unchanged rows unchanged.
5. Flags changed or missing source rows for review without silently overwriting or deleting history.
6. Refreshes the visible results and records the run.

General source cells remain read-only from Ahivim. Only the deliberately supported Paid marker is written back.

Push and pull are reported separately. A failed push must not pretend the pull failed, and a failed optional schedule match must not pretend the transaction import failed.

### 10.3 Idempotence and review

- Repeating the same Sheet snapshot does not duplicate transactions.
- An unchanged refresh may retry a prior optional schedule-matching failure.
- Changed source values open a conflict instead of overwriting an audited correction.
- A source row that disappears is not deleted from Ahivim.
- Missing deal setup does not block actual transaction visibility.
- Every run records counts, result, reconciliation note, and direct review action.

### 10.4 Transaction filtering

The transaction workspace should feel as controllable as Google Sheets while remaining safer.

Each meaningful column supports search and actual-value selection, including:

- Check date and check number
- Service period
- Program
- Individual
- Employee
- Payment recipient
- Hours
- Funder rate and amount
- Employee-base rate and amount
- Agency spread
- Paid and review state

Users can select multiple individuals or employees, Select All, Clear All, show or hide columns, reorder columns, and export the same result.

### 10.5 Totals follow the current view

Every displayed total must follow all active filters and selection state. Row mode and check mode must make repeated check-level values explicit so net pay is not multiplied across source rows.

The core money columns must remain separate:

- **Funder billed**
- **Employee base**
- **Agency spread**
- **Verified check gross**
- **Verified check net**
- **Withholding/taxes**

---

## 11. Budgets, Renewal, Pace, and History

### 11.1 Budget creation and program assignment

An administrator or permitted planner chooses an individual, program, authorization amount, and renewal. Renewal-only entry derives the annual dates. Dollar and Classes authorizations remain restricted to financial/class roles.

### 11.2 Current budget calculation

For hourly services:

`remaining = authorized hours - actual transaction hours`

`remaining after schedule = authorized hours - actual hours - eligible future scheduled hours`

For a dollar allowance:

`remaining = authorized dollars - posted usage from the declared source`

Usage must never be copied into a second manual ledger and counted twice.

### 11.3 Pace

The system compares both time elapsed and authorization consumed. It should identify:

- On track
- Behind pace or underused
- Tight, with more required than the remaining time can comfortably support
- Over authorization
- Expired with remaining balance
- Missing renewal
- Billing without a budget

Pace is guidance. It does not alter actual hours or the authorized amount.

### 11.4 History

Every individual/program budget shows monthly actual use and, when useful, scheduled future use. The user can see whether billing has been consistent, recently changed, or is unlikely to finish before renewal.

### 11.5 Revision and renewal

- Rate and authorization changes create revisions.
- A renewal creates a new period.
- Prior transactions remain attached to the period in which they occurred.
- Expired and missing-renewal records remain visible until repaired.
- Group credits follow the group service rule described in Section 3.6.

---

## 12. Financial Rules and Owner Agency Financials

### 12.1 Funder rate versus employee-base rate

The funder's rate and the employee-side rate are different business values.

Example:

- Funder rate: $25 per hour
- Employee-base rate: $21 per hour
- Agency spread: $4 per hour

Receiving $25 does not mean the employee receives $25. Taxes do not explain the $4 difference. The $4 is agency spread and stays separate from every employee or individual deal calculation.

For a group row, the combined rate may be a multiple of the base rate. The system must allocate the money correctly instead of treating the combined rate as an ordinary mismatch.

### 12.2 Sequential individual cuts

Cuts are sequential, not added together.

For a $1,000 basis with a 24% first cut and a 30% second cut:

1. First cut: $240
2. Remainder: $760
3. Second cut: 30% of $760, or $228
4. Remainder after both cuts: $532 before later adjustments

The system also supports one cut, no second cut, and dated adjustments. It preserves the entered approved final amount even when it differs from the calculated suggestion.

### 12.3 Fixed final monthly set-aside

Only the approved final monthly amount is the agency expense and put-away obligation.

If the approved result is $1,500 per month, the owner financial report records $1,500 for that month according to the active setup. It does not create separate expenses for the first cut and second cut, and it does not fluctuate merely because that month's transaction volume changed.

### 12.4 Taxes

For a verified payroll check:

`withholding/taxes = check gross - check net`

Taxes are tracked as an expense in the owner actual financial report because the agency did not keep that amount. Taxes are not an agency cut and are not part of the employee give-back percentage.

### 12.5 Direct-pay employee give-back

When payment goes directly to the employee, the rule applies once to the whole verified check **net**, not gross and not every transaction row.

Example:

- Verified check net: $1,200
- Employee keeps 80%
- Employee keep: $960
- Give-back to agency: $240

The system tracks obligation, collections, extra payment/credit, corrections, and remaining balance. The percentage label must make clear whether the configured number means employee keep or agency give-back.

### 12.6 Agency-routed employee share

When the agency receives the source payment, the employee may be owed a percentage of the employee-base amount.

- The effective employee-plus-individual rule takes priority.
- The employee default is the fallback.
- The rule divides employee base, never funder gross.
- Agency spread remains agency income and is not an employee expense.
- Missing rules are disclosed and excluded rather than guessed.

### 12.7 Individual program splits

For custom programs, classes, reimbursements, or other manually received income, an effective-dated split can identify the agency share and individual share for that person and program.

Splits may differ by individual. They must not overlap for the same person/program/date. A required missing split is a review condition, not permission to assume a favorable result.

### 12.8 Owner Agency Financials: actuals only

This owner-only report answers:

**What actual income was recorded, what actual expenses apply, and what remains for the agency for the selected month?**

It must not use projected budgets as income.

#### Income

- Actual committed Google Sheet transactions in the selected service month
- Manually recorded actual receipts for classes, reimbursements, custom programs, or other income

An issued class invoice is a receivable reference. It is not cash income until the actual receipt is recorded.

#### Expenses

- Approved final monthly individual set-asides
- Withholding/taxes from verified checks
- Employee keep on direct-pay net checks
- Agency-routed employee shares of employee base
- Individual shares of manually received program income

The first and second cuts are explanatory and are not separate expenses.

#### Result

`agency result = actual income - counted actual expenses`

Every category drills to its source. Missing gross, net, deal, split, or historical setup is disclosed and excluded.

### 12.9 Manual income

The owner can record an actual receipt with:

- Date
- Amount
- Category
- Program
- Individual when applicable
- Agency/individual split
- Invoice or source reference
- Note and audit reason

The system prevents duplicate enrichment of the same Sheet payment, supports separate receipts, and voids through an audited reversal rather than deletion.

---

## 13. Masser and the Payment Ledger

### 13.1 Two related but separate Masser responsibilities

The collector handles:

1. **Employee collections:** money an employee must give back to the agency.
2. **Individual put-away:** the approved final amount that must be recorded and shown for the individual.

These must not be confused with one another or with the owner's agency profit report.

### 13.2 Check confirmation

Imported check information enters a review state. The collector confirms gross, net, employee, and check identity. Only a verified check can create a direct-pay give-back obligation or change employee portal totals.

### 13.3 Transaction and pay-period tracking

Obligations remain traceable to the transaction/check period that created them. The user can see:

- Original due
- Amount recorded
- Date of each event
- Remaining balance
- Credit from extra payment
- Corrections and reversals
- History of who acted and when

The balance may increase or decrease as new obligations and events are recorded. A rule's effective date chooses the rule; it does not replace the event or transaction date.

### 13.4 Partial, extra, and corrected payments

- A partial payment reduces remaining balance.
- An extra payment creates credit rather than disappearing.
- A correction reverses the mistaken event and creates the corrected event.
- A completed item cannot be silently paid twice.
- Multi-select completion is allowed only when each selected item remains independently auditable.

### 13.5 Individual statement

The statement shows, by month and in total:

- Approved target
- Recorded put-away
- Corrections/reversals
- Credit
- Remaining

It does not identify employees or expose employee checks, taxes, deals, or collections.

### 13.6 Separation from Financial Setup

Financial Setup defines the approved arrangement. Masser executes and tracks it. Editing the calculation and recording a payment are separate actions with separate permissions and audit history.

---

## 14. Custom Programs, Classes, and Invoices

### 14.1 Custom programs

The owner can add a reusable program in Settings, then assign a dated authorization to selected individuals. A custom program may be hourly, dollar-based, payroll-backed, invoice-backed, or manually consumed according to its configuration.

For annual side-income programs, the individual record shows authorized, billed/posted, and remaining dollars. Actual receipts are recorded separately for Agency Financials.

### 14.2 Class allowance

Each participating individual can have an annual class dollar allowance, such as $20,000. The allowance is part of the individual's program budget and has its own renewal period.

### 14.3 Invoice builder

The class billing user can:

- Choose an individual and active allowance
- Choose class activities
- Start from standard rates and edit permitted details
- Generate a default month with up to 22 eligible service dates
- Never generate a Saturday service date
- Add, remove, or edit dates and lines before issue
- Preview the invoice and cover sheet
- Save a draft
- Issue the invoice atomically
- Void an issued invoice with a reason

Issuing consumes the allowance. Voiding reverses that consumption. Drafts do not consume the allowance.

### 14.4 Cover sheets and saved output

The workflow saves the invoice, cover-sheet attestation, generated output, and associated document history. Exact logos, signatures, and final visual identity require owner approval against supplied examples.

### 14.5 Invoice versus receipt

An issued invoice shows what was billed and reserves the class allowance. It does not prove the agency received cash. A separate actual receipt is required for owner Agency Financials.

---

## 15. Document Library and PDF Editor

### 15.1 Document library

The library is private and access-controlled. It supports:

- PDF upload
- Search and opening
- Archive instead of destructive deletion
- Immutable saved versions
- Restore of a prior version
- Draft recovery
- Access-gated streaming
- Saved class invoices and cover sheets

### 15.2 Current editor scope

The custom editor supports:

- Page navigation and zoom
- Reorder, delete, and rotate pages
- AcroForm filling
- Text, images, marks, drawing, and signatures
- OCR/native text inspection to help place edits
- Cover-and-replacement text overlays
- Imported fonts for new text where technically permitted
- High-fidelity or disclosed sanitized export
- Save, reopen, edit again, version, restore, and export

Saved editable state includes the original source, overlays, form values, page order, rotation, images, fonts, and export mode. A flattened export alone is not the editable master.

### 15.3 Adobe-class source-text editing requirement

The owner's desired experience includes selecting existing source text in place, changing it, preserving layout, and matching the original embedded font as closely as a paid Adobe editor.

The current custom engine does **not** truthfully provide arbitrary semantic reflow of existing source text in proprietary embedded fonts. Covering old text and placing new text is an overlay, not source-text editing.

To claim Adobe-equivalent source-text editing, the project must:

1. Select and license a commercial PDF SDK that permits source-text editing and required deployment use.
2. Integrate it with Ahivim's private document storage, versions, access control, and audit history.
3. Verify font fidelity and text reflow on the supplied invoices and cover sheets.
4. Verify save, reopen, second edit, restore, and export in production.

Until then, product language must call the current tool a PDF document/form/overlay editor, not an Adobe-equivalent source-text editor.

---

## 16. Reports

Reports exist to answer decisions, not to create disconnected copies of data.

### 16.1 Budget decisions

- **Budget utilization:** authorized, used, scheduled, and remaining by person/program
- **Budget exceptions:** materially behind pace or over authorization
- **Renewal pipeline:** authorizations ending soon and hours remaining
- **Actual vs. scheduled:** delivered activity versus current schedule

### 16.2 Money and planning

- **Agency financials:** owner-only actual income, expenses, and result
- **Billing spread by program:** funder billed, employee base, and agency spread
- **Employee base by recipient:** employee base grouped by employee and payment recipient
- **Program performance:** people, credited hours, physical hours, funder billed, employee base, and spread
- **Financial setup audit:** yearly gross through sequential cuts to the approved monthly final

### 16.3 Operational control

- **Scheduled, not billed**
- **Billed, not scheduled**
- **Group activity**

### 16.4 Data integrity

- **Configuration gaps:** missing rates or assignments
- **Name resolution history:** alias and matching decisions
- **Audit history:** who changed what, when, and why

### 16.5 Report rules

- Actuals always come from committed transactions or explicit actual receipt/events.
- Each report states its time basis.
- Filters and exports produce the same rows and totals.
- Group reports distinguish credited individual hours from physical employee hours.
- User-entered spreadsheet/export text is neutralized against formula injection.
- A report total must drill to the same source set whenever the user's permissions allow it.

---

## 17. Errors, Review States, and Action Handling

### 17.1 Plain-language errors

Users should never be shown raw database or query errors as the main guidance. The message should say what could not be completed, what remains safe, and what to do next.

### 17.2 Exact repair actions

Examples:

- Missing budget opens the person's budget setup.
- Unmatched name opens the exact match review.
- Rate difference opens the relevant program/person rate setup.
- Schedule conflict opens the exact session and employee availability.
- Missing check information opens check confirmation.
- Collection discrepancy opens the exact obligation and event history.
- Denied access returns to the user's own home and explains that the page is unavailable for that role.

### 17.3 Imports are not held hostage by optional setup

A successful transaction import remains successful when optional schedule matching, a deal, or a later review step is incomplete. The incomplete step is marked retryable/reviewable without mislabeling the committed source data as failed.

### 17.4 Interaction standard

Every mutating control must:

- Respond to the first click
- Show a busy state
- Disable duplicate submission
- Preserve entered values after a failure
- Show success or a useful error
- Refresh the affected totals without requiring repeated clicking

### 17.5 Empty and incomplete states

An empty state should distinguish:

- There is genuinely no data
- The user does not have access
- Setup is missing
- Data failed to load
- Filters exclude all rows

Each state provides the appropriate next action and no irrelevant warning list.

---

## 18. Permissions, Audit, and Security

### 18.1 Server-side authorization

Every page, API, export, document stream, and mutation checks the signed-in user on the server. Frontend visibility is only presentation.

### 18.2 Scoped access

Scopes include:

- Entire organization
- Selected individuals
- Selected employees
- Selected agencies
- Dated agency rosters
- Per-category grants and denials
- Per-member agency overrides

### 18.3 Sensitive categories

Money access is not one blanket switch. Separate categories include:

- Hours and budgets
- Funder billed
- Employee base
- Agency spread
- Check net
- Taxes
- Employee deals
- Settlements
- Class financials
- Document editing
- Planning and schedule management

### 18.4 Audit history

The system records the actor, action, entity, time, reason, previous state when needed, and new state. Sign In As keeps the owner as actor and preview user as target.

### 18.5 Non-destructive records

- Records are archived rather than silently deleted.
- Financial corrections use reversals.
- Issued invoice voids reverse allowance use.
- Rule revisions preserve the earlier effective period.
- Person merges preserve aliases and traceability.

### 18.6 Numerical integrity

Money and hours use decimal arithmetic and database numeric values. Floating-point shortcuts are not acceptable for authoritative calculations.

### 18.7 Private documents and secrets

Original and edited PDFs remain in private storage. Credentials, database strings, Sheet service-account keys, and storage tokens never appear in source code, logs shown to ordinary users, downloads, or client payloads.

---

## 19. User Experience Standard

The system succeeds when a simple user can work without training in the underlying spreadsheets.

### 19.1 Navigation

- Show only workspaces relevant to the role.
- Use familiar business names: Home, Transactions, People & Budgets, Schedule, Masser, Employees, Agencies, Classes, Reports.
- Keep advanced tools in secondary navigation or Settings.
- Preserve context when moving from a total to its source and back.

### 19.2 Information density

Operational pages should be compact, scannable, and table-first where comparison matters. Avoid decorative cards and oversized headings that push the work below the fold.

### 19.3 Labels

Use the owner's business terms consistently:

- Funder billed
- Employee base
- Agency spread
- Verified check gross
- Verified check net
- Withholding/taxes
- Give-back
- Put-away
- Masser
- Approved final / month
- Authorized, used, scheduled, remaining

Do not call funder billed "employee pay" or call agency spread "taxes."

### 19.4 Responsive behavior

Every daily workflow must remain usable on desktop and mobile without clipped controls, overlapping text, hidden totals, or unreasonably small click targets.

### 19.5 Accessibility and feedback

Controls use clear labels, keyboard access, visible focus, sufficient contrast, and meaningful progress/error feedback. A user should never need to press five times or guess whether an action started.

---

## 20. Product Success Criteria

The product is successful when all of the following are true:

1. The owner can reconcile dashboard, report, and export totals to exact source transactions.
2. The owner can select multiple people and see totals that follow every filter.
3. The budget planner can run the full job using hours with no money leakage.
4. The staffing manager can manage availability, assignments, and schedules without budgets or finance.
5. The collector can confirm checks, record partial/extra collections, manage credit/corrections, and produce an individual statement.
6. The class billing user can manage an allowance, build a non-Saturday invoice, issue/void it, and retain the output.
7. Every external account sees only directly linked or agency-scoped records and approved categories.
8. Sign In As reproduces the target user's experience and returns safely to the owner.
9. Google Sheet refresh is idempotent, clearly reports push/pull, and never duplicates or silently overwrites actuals.
10. Budget use comes from actual transactions or the program's single declared consumption source.
11. Financial Setup, Masser, and owner Agency Financials never count the same cut or receipt twice.
12. Direct-pay give-back is calculated once from verified check net.
13. Agency-routed employee pay is based on employee base, while agency spread remains separate.
14. Group hours and money reconcile according to the full-credit/one-physical-time rule.
15. Every problem state leads to the exact next action.
16. Buttons acknowledge the first click and do not lose work.
17. Audit history explains every sensitive change.
18. Desktop and mobile acceptance passes for every preset using a direct login.
19. The document library preserves privacy and editable version history.
20. The product does not claim Adobe-equivalent source-text editing without a licensed, verified SDK.

---

## Appendix A. Current Implementation and Delivery Status

This appendix summarizes the current repository and `PRODUCT_TRACEABILITY.md`. It is a status snapshot, not a substitute for production acceptance evidence.

### A.1 Status meanings

- **Production verified:** Deployed, configured, reconciled against representative real records, and accepted while signed in as the intended role on desktop and mobile.
- **Implemented:** The workflow and server boundary exist with focused automated coverage, but production acceptance remains.
- **Partial:** Meaningful implementation exists, but a known product, data, or UX gap remains.
- **External blocker:** Completion requires credentials, licensed technology, source history, or approval outside the codebase.
- **Missing:** The requested workflow does not exist.

### A.2 Overall verdict

No complete row is yet classified as **Production verified**.

There is meaningful partial production evidence: production commit `2801cf164af974fc78b8f94dd085ecafab54e3ea` passed database, schema, environment, and XLSX health; representative owner transaction and Agency Financials totals were reconciled; and owner Masser, agencies, schedule matching, repair links, read-only Sheet refresh, Owner-to-Owner Sign In As, and private document storage were observed. This does not replace role-by-role direct-login, mobile, mutating workflow, privacy-payload, or external-integration acceptance. In particular, that deployed baseline does not prove parent schedule privacy or bounded multi-row source links; the current hardening removes employee identity from parent schedules and replaces repeated transaction IDs with access-scoped source keys, pending deployment and direct-login acceptance.

### A.3 Implemented in the current product, pending full production acceptance

- Canonical transaction ledger and date logic
- Spreadsheet-style transaction filters, multi-person selection, totals, exports, and compact access-scoped Money-operation source drilldowns
- Current budget balances, renewals, pace, history, billing-without-budget, and planner hour authorization edits
- Group service detection and allocation rules
- Funder billed, employee base, and agency spread separation
- Direct-pay verified-check give-back from net
- Sequential individual cuts and approved final monthly set-aside
- Agency-routed employee share rules
- Owner Home and saved cohorts
- Owner Agency Financials and manual income
- Individual/program revenue splits
- Employee-plus-individual compensation terms
- Schedule, recurring schedules, availability, time off, conflicts, coverage, and direct-pay target hours
- Schedule-to-recorded matching and review
- Masser and settlement ledger
- Financial Setup
- Employees, individuals, agencies, and global programs
- Reports, imports, corrections, aliases, merges, and audit history
- Classes allowances, invoice issue/void, cover sheets, and saved output
- Private document library and current PDF form/overlay editor
- Preset user provisioning, granular portal capabilities, and Sign In As
- Individual/parent, employee, agency/provider, agency scheduler, agency staffing, and agency collector portals; the current parent schedule projection contains service facts only and omits employee identity
- First-click progress and actionable error patterns across high-use workflows

All items above still require the applicable production reconciliation, direct-login privacy review, desktop/mobile acceptance, and real mutation tests listed in `PRODUCT_TRACEABILITY.md`.

### A.4 Current production baseline

Production commit `2801cf164af974fc78b8f94dd085ecafab54e3ea` was deployed as Vercel deployment `8dSn6Jz1m2iHy153rgsKtfFgarAP` and assigned to `https://ahivim-budget-management.vercel.app`. The database, schema, environment, and XLSX health checks passed; the database reported all 39 migrations applied and 73 public tables. Migration `0038_unique_schedule_transaction_match.sql` is therefore active and enforces that one recorded transaction cannot be matched to two planned visits.

This is deployment and owner smoke-test evidence. It is not role-by-role production acceptance. The privacy and bounded-link hardening described in A.2 is newer than this baseline and must be deployed and accepted separately.

### A.5 External blockers and known limits

#### Google Sheet write-back

The push/pull workflow is implemented, but production service-account credentials are absent. A real Paid-marker push, pull, idempotent retry, and failure recovery remain unverified. Read-only pull can still operate with current configuration.

#### Adobe-equivalent source-text PDF editing

The current editor is implemented as a form, page, drawing, signature, and overlay editor. Arbitrary source-text reflow in proprietary embedded fonts remains blocked on a commercial SDK choice and license.

#### Dedicated database integration suite

`TEST_DATABASE_URL` is not configured in the documented acceptance environment. Database-backed integration suites intentionally skip without it and must be run before production verification.

#### Legacy group history

Historical group rows without reliable service-session links cannot provide exact deduplicated physical employee hours until repaired or backfilled.

#### Historical approved set-asides

Saved Financial Setup revisions support reliable as-of reconstruction from August 2026 forward. Earlier months without trustworthy snapshots remain disclosed and excluded until source history is supplied.

#### Class PDF identity

The owner must approve exact logos, brand marks, signatures, and final rendering against the supplied invoice and cover-sheet examples.

#### Document production round trip

Private storage is configured, but upload, edit, save, reopen, second save, restore, archive, download, and access-control acceptance must still be completed with real production documents.

### A.6 Remaining acceptance work

1. Retain `2801cf1` as the accepted production baseline; deploy each subsequent hardening commit and rerun database, schema, environment, XLSX health, and migration-count verification.
2. Run the complete unit, type, lint, build, and database integration suites with no skipped required suite.
3. Reconcile representative normal, group, renewal, no-budget, direct-pay, agency-routed, Masser, class, manual-income, split, and owner-result cases.
4. Provision every preset through the real user flow and test a direct login on desktop and mobile.
5. Inspect server responses and exports for forbidden role data, especially planner money fields, parent schedule employee identity, internal IDs, and external-person leakage.
6. Browser-test compact Money-operation source navigation with 1, 70, and 201 rows, including stale and copied links under restricted access.
7. Complete real Sheet write-back and private document round trips.
8. Obtain class PDF visual approval.
9. Make and document the commercial PDF SDK versus overlay-only product decision.

---

## Appendix B. Production Acceptance Record

For each role and major workflow, the acceptance record must include:

- Date and environment
- Exact deployed commit
- Applied migration count
- Account and preset used
- Direct login or Sign In As
- Desktop and mobile result
- Source records and expected totals
- Screen, export, and drilldown evidence
- Inspected privacy-sensitive response where applicable
- Pass/fail result
- Remaining issue and exact owner
- Business approver

The product is complete only when the operating system works as one connected truth and each portal proves that it exposes exactly the right portion of that truth.

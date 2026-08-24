import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  bigint,
  integer,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Database schema.
 *
 * This file is the Drizzle mirror of drizzle/0000_init.sql, which is the
 * migration that actually creates the database. The two are kept in lockstep:
 * if you change this file, generate a NEW migration (npm run db:generate) —
 * never edit an applied migration.
 *
 * Conventions
 * -----------
 *  - Money is numeric(14,4); hours are numeric(10,4); percentages are stored
 *    as decimal fractions in numeric(9,6). All arrive in TypeScript as strings
 *    and are handled with decimal.js. No authoritative value is a JS number.
 *  - Every table carries created_at/updated_at (timestamptz, default now()).
 *  - Soft references from imports are kept as *_raw text alongside resolved
 *    foreign keys, so the original workbook text always survives.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

/* -------------------------------------------------------------------------- */
/* People and programs                                                        */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** 'admin' | 'manager' | 'viewer' */
    role: text("role").default("viewer").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Access scope (mirror of drizzle/0014_user_access_scope.sql). 'full' | 'scoped'. */
    accessScope: text("access_scope").default("full").notNull(),
    seeAllIndividuals: boolean("see_all_individuals").default(false).notNull(),
    seeAllEmployees: boolean("see_all_employees").default(false).notNull(),
    canSeeTransactions: boolean("can_see_transactions").default(true).notNull(),
    canSeeMoney: boolean("can_see_money").default(true).notNull(),
    /** Granular visibility (mirror of drizzle/0018_granular_visibility.sql). */
    canSeeHours: boolean("can_see_hours").default(true).notNull(),
    canSeeBilledAmounts: boolean("can_see_billed_amounts").default(true).notNull(),
    canSeeEmployeeAmounts: boolean("can_see_employee_amounts").default(true).notNull(),
    canSeeAgencySpread: boolean("can_see_agency_spread").default(true).notNull(),
    canSeeCheckNet: boolean("can_see_check_net").default(true).notNull(),
    canSeeTaxes: boolean("can_see_taxes").default(true).notNull(),
    canSeeBudgets: boolean("can_see_budgets").default(true).notNull(),
    canSeeEmployeeDeals: boolean("can_see_employee_deals").default(false).notNull(),
    canSeeSettlements: boolean("can_see_settlements").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

/**
 * Per-user access grants (mirror of drizzle/0014_user_access_scope.sql). A scoped
 * viewer may see the individuals / employees granted here, plus the connected set.
 */
export const userIndividualAccess = pgTable(
  "user_individual_access",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id").notNull().references(() => individuals.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.individualId] }),
    index("user_individual_access_user_idx").on(table.userId),
    index("user_individual_access_individual_idx").on(table.individualId),
  ],
);

export const userEmployeeAccess = pgTable(
  "user_employee_access",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.employeeId] }),
    index("user_employee_access_user_idx").on(table.userId),
    index("user_employee_access_employee_idx").on(table.employeeId),
  ],
);

export const individuals = pgTable(
  "individuals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normalizedName: text("normalized_name").notNull(),
    displayName: text("display_name").notNull(),
    externalRef: text("external_ref"),
    notes: text("notes"),
    /** Dashboard side info (0016): a contact phone and a free-form category / account tag. */
    phone: text("phone"),
    category: text("category"),
    legalName: text("legal_name"),
    preferredName: text("preferred_name"),
    status: text("status").default("active").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("individuals_normalized_name_key").on(table.normalizedName)],
);

export const individualAliases = pgTable(
  "individual_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    normalizedAlias: text("normalized_alias").notNull(),
    sourceText: text("source_text").notNull(),
    /** 'pending' | 'approved' — only approved aliases resolve imports. */
    status: text("status").default("pending").notNull(),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("individual_aliases_alias_key").on(table.normalizedAlias)],
);

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normalizedName: text("normalized_name").notNull(),
    displayName: text("display_name").notNull(),
    externalRef: text("external_ref"),
    status: text("status").default("active").notNull(),
    notes: text("notes"),
    /** A separate payout cut (0016): a percentage taken from what is paid to this
     *  employee, paid to him separately. Stored as a decimal fraction (0.10 = 10%). */
    payoutCutPercent: numeric("payout_cut_percent", { precision: 9, scale: 6 }).default("0").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("employees_normalized_name_key").on(table.normalizedName)],
);

export const employeeAliases = pgTable(
  "employee_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    normalizedAlias: text("normalized_alias").notNull(),
    sourceText: text("source_text").notNull(),
    status: text("status").default("pending").notNull(),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("employee_aliases_alias_key").on(table.normalizedAlias)],
);

export const programs = pgTable(
  "programs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isGroupCapable: boolean("is_group_capable").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    // Configurable operational rules (0005). Defaults: most programs are
    // one-to-one; groups are opt-in; self-hire does not convert.
    oneToOneRequired: boolean("one_to_one_required").default(true).notNull(),
    groupsAllowed: boolean("groups_allowed").default(false).notNull(),
    maxGroupSize: integer("max_group_size"),
    allowMultipleEmployees: boolean("allow_multiple_employees").default(false).notNull(),
    allowMultipleIndividuals: boolean("allow_multiple_individuals").default(false).notNull(),
    allowIndividualRateOverride: boolean("allow_individual_rate_override").default(true).notNull(),
    selfHireConverts: boolean("self_hire_converts").default(false).notNull(),
    agencyAdditionalRate: numeric("agency_additional_rate", { precision: 14, scale: 4 }),
    requiredAuthType: text("required_auth_type").default("hours").notNull(),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("programs_code_key").on(table.code)],
);

export const programAliases = pgTable(
  "program_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    normalizedAlias: text("normalized_alias").notNull(),
    sourceText: text("source_text").notNull(),
    status: text("status").default("approved").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("program_aliases_alias_key").on(table.normalizedAlias)],
);

/**
 * Effective-dated rates. Internal rates are configuration, never hardcoded.
 * agency_rate is null for self-hire programs, whose rows never convert.
 */
export const programRateSchedules = pgTable(
  "program_rate_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    agencyRate: numeric("agency_rate", { precision: 14, scale: 4 }),
    internalRate: numeric("internal_rate", { precision: 14, scale: 4 }).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("program_rate_schedules_program_idx").on(table.programId, table.effectiveFrom),
  ],
);

/* -------------------------------------------------------------------------- */
/* Calculation strategies                                                     */
/* -------------------------------------------------------------------------- */

/** A fixed annual budget strategy for one individual. */
export const calculationStrategies = pgTable(
  "calculation_strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    label: text("label").default("1").notNull(),
    renewalDate: date("renewal_date"),
    monthDivisor: numeric("month_divisor", { precision: 6, scale: 3 }).default("12").notNull(),
    cut1Percent: numeric("cut1_percent", { precision: 9, scale: 6 }).default("0").notNull(),
    cut2Percent: numeric("cut2_percent", { precision: 9, scale: 6 }).default("0").notNull(),
    clockAdjustment: numeric("clock_adjustment", { precision: 14, scale: 4 }).default("0").notNull(),
    otherAdjustment: numeric("other_adjustment", { precision: 14, scale: 4 }).default("0").notNull(),
    afterAll: numeric("after_all", { precision: 14, scale: 4 }),
    account: text("account"),
    status: text("status").default("active").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("calc_strategies_individual_idx").on(table.individualId)],
);

/** Per-program authorized hours and optional rate override for a strategy. */
export const calculationStrategyLines = pgTable(
  "calculation_strategy_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => calculationStrategies.id, { onDelete: "cascade" }),
    programId: uuid("program_id").notNull().references(() => programs.id),
    authorizedHours: numeric("authorized_hours", { precision: 10, scale: 4 }).default("0").notNull(),
    rateOverride: numeric("rate_override", { precision: 14, scale: 4 }),
    rateOverrideEffectiveFrom: date("rate_override_effective_from"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("calc_strategy_lines_unique").on(table.strategyId, table.programId),
  ],
);

/** Append-only snapshots of prior strategy and line state. */
export const calculationStrategyRevisions = pgTable(
  "calculation_strategy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => calculationStrategies.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => [
    index("calc_strategy_revisions_strategy_idx").on(table.strategyId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Budgets                                                                    */
/* -------------------------------------------------------------------------- */

/** A budget period is an explicit date range. Twelve months is not assumed. */
export const budgetPeriods = pgTable(
  "budget_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    /** 'calendar' | 'rolling' | 'custom' (0005). */
    periodType: text("period_type").default("custom").notNull(),
    renewalDate: date("renewal_date"),
    /** Actual months in the period (e.g. 7.000), for monthly planning. */
    planningMonths: numeric("planning_months", { precision: 6, scale: 3 }),
    isPartialPeriod: boolean("is_partial_period").default(false).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("budget_periods_individual_idx").on(table.individualId, table.startDate)],
);

/** Authorized HOURS per program per period. Dollar value is derived. */
export const budgetAuthorizations = pgTable(
  "budget_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetPeriodId: uuid("budget_period_id")
      .notNull()
      .references(() => budgetPeriods.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id),
    authorizedHours: numeric("authorized_hours", { precision: 10, scale: 4 }).notNull(),
    /** The internal rate in force when this authorization was recorded. */
    internalRate: numeric("internal_rate", { precision: 14, scale: 4 }).notNull(),
    rateOverride: boolean("rate_override").default(false).notNull(),
    sourceRowRef: text("source_row_ref"),
    revision: integer("revision").default(1).notNull(),
    supersedesId: uuid("supersedes_id"),
    status: text("status").default("active").notNull(),
    authorizedDollars: numeric("authorized_dollars", { precision: 14, scale: 4 }),
    // Individual-specific rate overrides on an authorization (0005).
    agencyRate: numeric("agency_rate", { precision: 14, scale: 4 }),
    individualRateOverride: numeric("individual_rate_override", { precision: 14, scale: 4 }),
    rateBasis: text("rate_basis"),
    notes: text("notes"),
    source: text("source"),
    createdByUserId: uuid("created_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("budget_auth_period_program_key").on(table.budgetPeriodId, table.programId),
    index("budget_auth_individual_idx").on(table.individualId),
  ],
);

/** Per-individual cut configuration (percentages as decimal fractions). */
export const accountConfigurations = pgTable(
  "account_configurations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    firstCutPercent: numeric("first_cut_percent", { precision: 9, scale: 6 })
      .default("0")
      .notNull(),
    secondCutPercent: numeric("second_cut_percent", { precision: 9, scale: 6 })
      .default("0")
      .notNull(),
    notes: text("notes"),
    /** Calculations column S, preserved verbatim. Meaning unresolved. */
    unresolvedColumnS: text("unresolved_column_s"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("account_configurations_individual_key").on(table.individualId)],
);

/**
 * The account waterfall for one individual in one period.
 * Sequential cuts: the second cut applies to the remainder after the first.
 * The third cut is adjustable and employee_cash = remaining_after_second - third.
 */
export const accountPeriods = pgTable(
  "account_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    budgetPeriodId: uuid("budget_period_id").references(() => budgetPeriods.id),
    grossAmount: numeric("gross_amount", { precision: 14, scale: 4 }).default("0").notNull(),
    firstCutPercent: numeric("first_cut_percent", { precision: 9, scale: 6 })
      .default("0")
      .notNull(),
    firstCutAmount: numeric("first_cut_amount", { precision: 14, scale: 4 })
      .default("0")
      .notNull(),
    remainingAfterFirstCut: numeric("remaining_after_first_cut", { precision: 14, scale: 4 })
      .default("0")
      .notNull(),
    secondCutPercent: numeric("second_cut_percent", { precision: 9, scale: 6 })
      .default("0")
      .notNull(),
    secondCutAmount: numeric("second_cut_amount", { precision: 14, scale: 4 })
      .default("0")
      .notNull(),
    remainingAfterSecondCut: numeric("remaining_after_second_cut", { precision: 14, scale: 4 })
      .default("0")
      .notNull(),
    thirdCutAmount: numeric("third_cut_amount", { precision: 14, scale: 4 })
      .default("0")
      .notNull(),
    thirdCutIsManual: boolean("third_cut_is_manual").default(false).notNull(),
    employeeCashAmount: numeric("employee_cash_amount", { precision: 14, scale: 4 })
      .default("0")
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("account_periods_individual_idx").on(table.individualId)],
);

export const accountAdjustments = pgTable(
  "account_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountPeriodId: uuid("account_period_id")
      .notNull()
      .references(() => accountPeriods.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    previousValue: text("previous_value"),
    newValue: text("new_value"),
    reason: text("reason"),
    adjustedByUserId: uuid("adjusted_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("account_adjustments_period_idx").on(table.accountPeriodId)],
);

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

export const importedFiles = pgTable(
  "imported_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    originalFilename: text("original_filename").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** SHA-256 of the raw upload. The same file can never be committed twice. */
    checksumSha256: text("checksum_sha256").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    templateDetected: text("template_detected"),
    sheetSummary: jsonb("sheet_summary"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("imported_files_checksum_key").on(table.checksumSha256)],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importedFileId: uuid("imported_file_id")
      .notNull()
      .references(() => importedFiles.id, { onDelete: "cascade" }),
    /** 'staged' | 'committed' | 'discarded' */
    status: text("status").default("staged").notNull(),
    startedByUserId: uuid("started_by_user_id").references(() => users.id),
    committedByUserId: uuid("committed_by_user_id").references(() => users.id),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    totalRows: integer("total_rows").default(0).notNull(),
    validRows: integer("valid_rows").default(0).notNull(),
    importedRows: integer("imported_rows").default(0).notNull(),
    skippedRows: integer("skipped_rows").default(0).notNull(),
    duplicateRows: integer("duplicate_rows").default(0).notNull(),
    warningRows: integer("warning_rows").default(0).notNull(),
    errorRows: integer("error_rows").default(0).notNull(),
    sourceAgencyGross: numeric("source_agency_gross", { precision: 14, scale: 4 }),
    importedAgencyGross: numeric("imported_agency_gross", { precision: 14, scale: 4 }),
    sourceInternalAmount: numeric("source_internal_amount", { precision: 14, scale: 4 }),
    importedInternalAmount: numeric("imported_internal_amount", { precision: 14, scale: 4 }),
    reconciliationNotes: text("reconciliation_notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("import_batches_file_idx").on(table.importedFileId)],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importBatchId: uuid("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    sheetName: text("sheet_name").notNull(),
    sourceRowNumber: integer("source_row_number").notNull(),
    /** Every cell of the source row, verbatim. Nothing is discarded. */
    rawValues: jsonb("raw_values").notNull(),
    /** 'pending' | 'valid' | 'invalid' | 'needs_review' | 'duplicate' | 'imported' | 'skipped' */
    status: text("status").default("pending").notNull(),
    validationErrors: jsonb("validation_errors"),
    resolvedIndividualId: uuid("resolved_individual_id").references(() => individuals.id),
    resolvedEmployeeId: uuid("resolved_employee_id").references(() => employees.id),
    resolvedProgramId: uuid("resolved_program_id").references(() => programs.id),
    transactionFingerprint: text("transaction_fingerprint"),
    // Phase 3 corrections (0004): raw_values is never overwritten; corrections
    // live here as a sparse { field: value } patch with their own audit.
    correctedValues: jsonb("corrected_values"),
    correctionStatus: text("correction_status"),
    correctedByUserId: uuid("corrected_by_user_id").references(() => users.id),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    correctionReason: text("correction_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("import_rows_batch_idx").on(table.importBatchId, table.status),
    index("import_rows_fingerprint_idx").on(table.transactionFingerprint),
  ],
);

export const importWarnings = pgTable(
  "import_warnings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importBatchId: uuid("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    importRowId: uuid("import_row_id").references(() => importRows.id),
    individualId: uuid("individual_id").references(() => individuals.id),
    category: text("category").notNull(),
    /** 'info' | 'warning' | 'error' */
    severity: text("severity").default("warning").notNull(),
    message: text("message").notNull(),
    details: jsonb("details"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("import_warnings_batch_idx").on(table.importBatchId, table.category)],
);

/* -------------------------------------------------------------------------- */
/* Transactions and group services                                            */
/* -------------------------------------------------------------------------- */

export const payrollTransactions = pgTable(
  "payroll_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id),
    importRowId: uuid("import_row_id").references(() => importRows.id),
    sourceFileId: uuid("source_file_id").references(() => importedFiles.id),
    sourceRowNumber: integer("source_row_number"),
    payToRaw: text("pay_to_raw"),
    checkNumber: text("check_number"),
    checkDate: date("check_date"),
    periodBegin: date("period_begin"),
    periodEnd: date("period_end"),
    individualId: uuid("individual_id").references(() => individuals.id),
    employeeId: uuid("employee_id").references(() => employees.id),
    programId: uuid("program_id").references(() => programs.id),
    individualRaw: text("individual_raw"),
    employeeRaw: text("employee_raw"),
    programRaw: text("program_raw"),
    importedHours: numeric("imported_hours", { precision: 10, scale: 4 }),
    /** On a group row this is the COMBINED rate. */
    importedRate: numeric("imported_rate", { precision: 14, scale: 4 }),
    importedAmount: numeric("imported_amount", { precision: 14, scale: 4 }),
    totalNetPay: numeric("total_net_pay", { precision: 14, scale: 4 }),
    /** Column P as it appeared in the workbook. */
    spreadsheetInternalAmount: numeric("spreadsheet_internal_amount", {
      precision: 14,
      scale: 4,
    }),
    /** The application's own internal-amount calculation. */
    calculatedInternalAmount: numeric("calculated_internal_amount", {
      precision: 14,
      scale: 4,
    }),
    internalRateApplied: numeric("internal_rate_applied", { precision: 14, scale: 4 }),
    agencyRateApplied: numeric("agency_rate_applied", { precision: 14, scale: 4 }),
    // Agency-vs-employee split (0005). Back-filled by payment-attribution, never
    // written during import. imported_amount is never touched.
    agencyAdditionalAmount: numeric("agency_additional_amount", { precision: 14, scale: 4 }),
    employeePaymentAmount: numeric("employee_payment_amount", { precision: 14, scale: 4 }),
    /** 'employee' | 'excellent_staffing' | 'unknown' */
    paymentRecipient: text("payment_recipient"),
    internalAmountMismatch: boolean("internal_amount_mismatch").default(false).notNull(),
    transactionFingerprint: text("transaction_fingerprint").notNull(),
    /** 'new' | 'possible' | 'confirmed' */
    duplicateStatus: text("duplicate_status").default("new").notNull(),
    isGroupService: boolean("is_group_service").default(false).notNull(),
    /**
     * Set when the transaction belongs to a group service session. Kept as a
     * plain uuid (no FK) to avoid a circular reference with service tables.
     */
    serviceSessionId: uuid("service_session_id"),
    /** Operator-managed payout tracking (0013). */
    isPaid: boolean("is_paid").default(false).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidNote: text("paid_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("payroll_tx_fingerprint_idx").on(table.transactionFingerprint),
    index("payroll_tx_individual_idx").on(table.individualId, table.periodBegin),
    index("payroll_tx_employee_idx").on(table.employeeId),
    index("payroll_tx_check_idx").on(table.checkNumber),
  ],
);

/**
 * One physical service occurrence. For a group, hours here are the employee's
 * PHYSICAL hours — stored once, never divided.
 */
export const serviceSessions = pgTable(
  "service_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id),
    employeeId: uuid("employee_id").references(() => employees.id),
    programId: uuid("program_id").references(() => programs.id),
    checkNumber: text("check_number"),
    periodBegin: date("period_begin"),
    periodEnd: date("period_end"),
    physicalHours: numeric("physical_hours", { precision: 10, scale: 4 }).notNull(),
    groupSize: integer("group_size").default(1).notNull(),
    combinedRate: numeric("combined_rate", { precision: 14, scale: 4 }),
    combinedAmount: numeric("combined_amount", { precision: 14, scale: 4 }),
    baseIndividualRate: numeric("base_individual_rate", { precision: 14, scale: 4 }),
    /** 'single' | 'detected' | 'needs_review' | 'confirmed' */
    groupDetectionStatus: text("group_detection_status").default("single").notNull(),
    detectionRule: text("detection_rule"),
    detectionSignature: text("detection_signature"),
    confidence: numeric("confidence", { precision: 9, scale: 6 }),
    validationResult: jsonb("validation_result"),
    warningReason: text("warning_reason"),
    sourceRowRefs: jsonb("source_row_refs"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("service_sessions_signature_idx").on(table.detectionSignature)],
);

/**
 * One individual's share of a service session. For a group of three:
 * three allocations, each with the FULL physical hours and a third of the
 * money. Rounding differences are recorded, never silently absorbed.
 */
export const serviceAllocations = pgTable(
  "service_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceSessionId: uuid("service_session_id")
      .notNull()
      .references(() => serviceSessions.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id),
    payrollTransactionId: uuid("payroll_transaction_id").references(() => payrollTransactions.id),
    allocationHours: numeric("allocation_hours", { precision: 10, scale: 4 }).notNull(),
    allocatedRate: numeric("allocated_rate", { precision: 14, scale: 4 }).notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 14, scale: 4 }).notNull(),
    roundingAdjustment: numeric("rounding_adjustment", { precision: 14, scale: 4 })
      .default("0")
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("service_allocations_individual_idx").on(table.individualId),
    uniqueIndex("service_allocations_session_individual_key").on(
      table.serviceSessionId,
      table.individualId,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Exceptions and audit                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A transaction whose imported rate does not sit on either configured rate
 * ladder. The imported rate is preserved and imported; the variance is
 * recorded here for review. Nothing is silently rewritten.
 */
export const rateExceptions = pgTable(
  "rate_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id),
    payrollTransactionId: uuid("payroll_transaction_id").references(() => payrollTransactions.id),
    individualId: uuid("individual_id").references(() => individuals.id),
    programId: uuid("program_id").references(() => programs.id),
    importedRate: numeric("imported_rate", { precision: 14, scale: 4 }).notNull(),
    expectedRate: numeric("expected_rate", { precision: 14, scale: 4 }).notNull(),
    varianceAmount: numeric("variance_amount", { precision: 14, scale: 4 }).notNull(),
    variancePercent: numeric("variance_percent", { precision: 9, scale: 6 }).notNull(),
    /** 'higher' | 'lower' */
    direction: text("direction").notNull(),
    /** 'open' | 'accepted' | 'corrected' */
    resolution: text("resolution").default("open").notNull(),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("rate_exceptions_batch_idx").on(table.importBatchId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (table) => [index("audit_logs_entity_idx").on(table.entityType, table.entityId)],
);

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id").notNull().references(() => individuals.id, { onDelete: "cascade" }),
    programId: uuid("program_id").references(() => programs.id),
    startDate: date("start_date"),
    endDate: date("end_date"),
    allowedHours: numeric("allowed_hours", { precision: 10, scale: 4 }),
    /** 'active' | 'ended' | 'archived' */
    status: text("status").default("active").notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("assignments_employee_idx").on(table.employeeId),
    index("assignments_individual_idx").on(table.individualId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Scheduling (Phase 2) — mirror of drizzle/0003_scheduling.sql               */
/* -------------------------------------------------------------------------- */

/**
 * A recurring template. Occurrences are materialised into scheduled_sessions
 * up front so a single occurrence can be edited or cancelled independently of
 * the series.
 */
export const scheduleSeries = pgTable(
  "schedule_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").references(() => employees.id),
    programId: uuid("program_id").references(() => programs.id),
    serviceType: text("service_type"),
    /** 'weekly' | 'daily' */
    frequency: text("frequency").default("weekly").notNull(),
    interval: integer("interval").default(1).notNull(),
    /** JSON array of weekday numbers, 0=Sunday..6=Saturday */
    weekdays: jsonb("weekdays"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    durationHours: numeric("duration_hours", { precision: 10, scale: 4 }),
    expectedRate: numeric("expected_rate", { precision: 14, scale: 4 }),
    /** 'active' | 'cancelled' */
    status: text("status").default("active").notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

/**
 * One planned session on one date. Expected billing mirrors the actual model:
 * every participant is credited the full session hours; the money divides.
 * matched_transaction_id / reconciliation_status feed Phase 3 reconciliation.
 */
export const scheduledSessions = pgTable(
  "scheduled_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seriesId: uuid("series_id").references(() => scheduleSeries.id, { onDelete: "set null" }),
    employeeId: uuid("employee_id").references(() => employees.id),
    programId: uuid("program_id").references(() => programs.id),
    serviceType: text("service_type"),
    sessionDate: date("session_date").notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    durationHours: numeric("duration_hours", { precision: 10, scale: 4 }).notNull(),
    isGroup: boolean("is_group").default(false).notNull(),
    groupSize: integer("group_size").default(1).notNull(),
    expectedRate: numeric("expected_rate", { precision: 14, scale: 4 }),
    expectedAgencyGross: numeric("expected_agency_gross", { precision: 14, scale: 4 }),
    expectedInternalAmount: numeric("expected_internal_amount", { precision: 14, scale: 4 }),
    expectedEmployeeCost: numeric("expected_employee_cost", { precision: 14, scale: 4 }),
    // Agency-vs-employee split on the plan side (0005).
    expectedAgencyAdditional: numeric("expected_agency_additional", { precision: 14, scale: 4 }),
    expectedEmployeePayment: numeric("expected_employee_payment", { precision: 14, scale: 4 }),
    /** 'employee' | 'excellent_staffing' | 'unknown' */
    paymentRecipient: text("payment_recipient"),
    /** 'pending' | 'completed' | 'cancelled' | 'no_show' */
    status: text("status").default("pending").notNull(),
    overrideReason: text("override_reason"),
    warnings: jsonb("warnings"),
    /** 'manual' | 'recurring' */
    source: text("source").default("manual").notNull(),
    matchedTransactionId: uuid("matched_transaction_id").references(() => payrollTransactions.id),
    reconciliationStatus: text("reconciliation_status"),
    // Phase 3 reconciliation audit (0004). The match itself is the two columns
    // above; these record who reconciled it and why.
    reconciledByUserId: uuid("reconciled_by_user_id").references(() => users.id),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciliationReason: text("reconciliation_reason"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("scheduled_sessions_date_idx").on(table.sessionDate),
    index("scheduled_sessions_employee_idx").on(table.employeeId, table.sessionDate),
    index("scheduled_sessions_series_idx").on(table.seriesId),
    index("scheduled_sessions_match_idx").on(table.matchedTransactionId),
  ],
);

/** One individual's share of a planned session (full hours, divided money). */
export const scheduledAllocations = pgTable(
  "scheduled_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduledSessionId: uuid("scheduled_session_id")
      .notNull()
      .references(() => scheduledSessions.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    allocationHours: numeric("allocation_hours", { precision: 10, scale: 4 }).notNull(),
    allocatedRate: numeric("allocated_rate", { precision: 14, scale: 4 }),
    allocatedAmount: numeric("allocated_amount", { precision: 14, scale: 4 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("scheduled_allocations_session_idx").on(table.scheduledSessionId),
    index("scheduled_allocations_individual_idx").on(table.individualId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Calculation workflow + config (Phase 4A) — mirror of 0005                  */
/* -------------------------------------------------------------------------- */

/**
 * One saved calculation for an individual/program: annual gross -> monthly ->
 * sequential cuts -> clock adjustment -> final gross / net / "After All". Every
 * step is stored, not just the result. Revisions supersede; history is kept.
 */
export const budgetCalculations = pgTable(
  "budget_calculations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    programId: uuid("program_id").references(() => programs.id),
    budgetPeriodId: uuid("budget_period_id").references(() => budgetPeriods.id),
    annualAuthorizedHours: numeric("annual_authorized_hours", { precision: 10, scale: 4 }),
    annualAuthorizedDollars: numeric("annual_authorized_dollars", { precision: 14, scale: 4 }),
    programRate: numeric("program_rate", { precision: 14, scale: 4 }),
    individualRateOverride: numeric("individual_rate_override", { precision: 14, scale: 4 }),
    effectiveRate: numeric("effective_rate", { precision: 14, scale: 4 }),
    months: integer("months").default(12).notNull(),
    annualGross: numeric("annual_gross", { precision: 14, scale: 4 }),
    monthlyGross: numeric("monthly_gross", { precision: 14, scale: 4 }),
    cut1Percent: numeric("cut1_percent", { precision: 9, scale: 6 }),
    cut1Amount: numeric("cut1_amount", { precision: 14, scale: 4 }),
    cut2Percent: numeric("cut2_percent", { precision: 9, scale: 6 }),
    cut2Amount: numeric("cut2_amount", { precision: 14, scale: 4 }),
    clockAdjustment: numeric("clock_adjustment", { precision: 14, scale: 4 }).default("0").notNull(),
    finalGross: numeric("final_gross", { precision: 14, scale: 4 }),
    finalNet: numeric("final_net", { precision: 14, scale: 4 }),
    afterAll: numeric("after_all", { precision: 14, scale: 4 }),
    agencyAdditional: numeric("agency_additional", { precision: 14, scale: 4 }),
    basis: text("basis").default("annual").notNull(),
    formulaVersion: text("formula_version").default("v1").notNull(),
    spreadsheetValue: numeric("spreadsheet_value", { precision: 14, scale: 4 }),
    revision: integer("revision").default(1).notNull(),
    supersedesId: uuid("supersedes_id"),
    status: text("status").default("active").notNull(),
    effectiveFrom: date("effective_from"),
    notes: text("notes"),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("budget_calculations_individual_idx").on(table.individualId, table.status),
    index("budget_calculations_program_idx").on(table.programId),
  ],
);

/** Admin-editable global configuration (default cuts, cut order, months, …). */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/* Employee deals and settlement ledger (0017)                                */
/* -------------------------------------------------------------------------- */

/**
 * Effective-dated terms selected by a payroll transaction's check date.
 * Direct-paid giveback percentages apply to the whole-check net pay. Agency
 * cut percentages apply to the base/internal amount routed to the agency.
 */
export const employeeDeals = pgTable(
  "employee_deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    /** 'keep_all' | 'giveback_percent' | 'giveback_all' */
    directRule: text("direct_rule").default("keep_all").notNull(),
    directPercent: numeric("direct_percent", { precision: 9, scale: 6 }).default("0").notNull(),
    agencyCutPercent: numeric("agency_cut_percent", { precision: 9, scale: 6 })
      .default("0")
      .notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    revision: integer("revision").default(1).notNull(),
    /** 'active' | 'archived' */
    status: text("status").default("active").notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("employee_deals_employee_effective_key").on(
      table.employeeId,
      table.effectiveFrom,
    ),
    index("employee_deals_effective_idx").on(
      table.employeeId,
      table.status,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    check(
      "employee_deals_direct_rule_check",
      sql`${table.directRule} in ('keep_all', 'giveback_percent', 'giveback_all')`,
    ),
    check(
      "employee_deals_direct_percent_check",
      sql`${table.directPercent} >= 0 and ${table.directPercent} <= 1`,
    ),
    check(
      "employee_deals_agency_cut_percent_check",
      sql`${table.agencyCutPercent} >= 0 and ${table.agencyCutPercent} <= 1`,
    ),
    check(
      "employee_deals_effective_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check("employee_deals_revision_check", sql`${table.revision} > 0`),
    check(
      "employee_deals_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "employee_deals_archive_state_check",
      sql`(${table.status} = 'archived') = (${table.archivedAt} is not null)`,
    ),
  ],
);

/** Append-only JSON snapshots written before each material deal change. */
export const employeeDealRevisions = pgTable(
  "employee_deal_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeDealId: uuid("employee_deal_id").notNull().references(() => employeeDeals.id),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("employee_deal_revisions_deal_revision_key").on(
      table.employeeDealId,
      table.revision,
    ),
    check("employee_deal_revisions_revision_check", sql`${table.revision} > 0`),
    check(
      "employee_deal_revisions_snapshot_check",
      sql`jsonb_typeof(${table.snapshot}) = 'object'`,
    ),
    check(
      "employee_deal_revisions_reason_check",
      sql`length(btrim(${table.reason})) > 0`,
    ),
  ],
);

/** One operator action that can create many settlement events atomically. */
export const settlementBatches = pgTable(
  "settlement_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    action: text("action").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("settlement_batches_idempotency_key").on(table.idempotencyKey),
    check("settlement_batches_action_check", sql`length(btrim(${table.action})) > 0`),
    check(
      "settlement_batches_metadata_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  ],
);

/**
 * A positive amount owed, reserved, or payable. Outstanding balance is the
 * original amount minus signed settlement events. source_key is a stable,
 * deterministic calculation identity so recalculation remains idempotent.
 */
export const settlementObligations = pgTable(
  "settlement_obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKey: text("source_key").notNull(),
    kind: text("kind").notNull(),
    /** 'receivable' | 'payable' | 'reserve' */
    direction: text("direction").notNull(),
    employeeId: uuid("employee_id").references(() => employees.id),
    individualId: uuid("individual_id").references(() => individuals.id),
    employeeDealId: uuid("employee_deal_id").references(() => employeeDeals.id),
    calculationStrategyId: uuid("calculation_strategy_id").references(
      () => calculationStrategies.id,
    ),
    originalAmount: numeric("original_amount", { precision: 14, scale: 4 }).notNull(),
    checkNumber: text("check_number"),
    checkDate: date("check_date"),
    periodBegin: date("period_begin"),
    periodEnd: date("period_end"),
    calculationMetadata: jsonb("calculation_metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    /** 'active' | 'void' */
    status: text("status").default("active").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("settlement_obligations_source_key_key").on(table.sourceKey),
    index("settlement_obligations_employee_idx").on(
      table.employeeId,
      table.status,
      table.checkDate,
    ),
    index("settlement_obligations_individual_idx").on(
      table.individualId,
      table.status,
      table.checkDate,
    ),
    index("settlement_obligations_deal_idx").on(table.employeeDealId),
    index("settlement_obligations_strategy_idx").on(table.calculationStrategyId),
    check(
      "settlement_obligations_source_key_check",
      sql`length(btrim(${table.sourceKey})) > 0`,
    ),
    check("settlement_obligations_kind_check", sql`length(btrim(${table.kind})) > 0`),
    check(
      "settlement_obligations_direction_check",
      sql`${table.direction} in ('receivable', 'payable', 'reserve')`,
    ),
    check(
      "settlement_obligations_person_check",
      sql`(${table.employeeId} is not null) <> (${table.individualId} is not null)`,
    ),
    check("settlement_obligations_amount_check", sql`${table.originalAmount} > 0`),
    check(
      "settlement_obligations_period_check",
      sql`${table.periodEnd} is null or ${table.periodBegin} is null or ${table.periodEnd} >= ${table.periodBegin}`,
    ),
    check(
      "settlement_obligations_metadata_check",
      sql`jsonb_typeof(${table.calculationMetadata}) = 'object'`,
    ),
    check(
      "settlement_obligations_status_check",
      sql`${table.status} in ('active', 'void')`,
    ),
    check(
      "settlement_obligations_void_state_check",
      sql`(${table.status} = 'void') = (${table.voidedAt} is not null)`,
    ),
  ],
);

/** Transaction provenance for a generated settlement obligation. */
export const settlementObligationTransactions = pgTable(
  "settlement_obligation_transactions",
  {
    settlementObligationId: uuid("settlement_obligation_id")
      .notNull()
      .references(() => settlementObligations.id),
    payrollTransactionId: uuid("payroll_transaction_id")
      .notNull()
      .references(() => payrollTransactions.id),
    allocatedAmount: numeric("allocated_amount", { precision: 14, scale: 4 }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "settlement_obligation_transactions_pk",
      columns: [table.settlementObligationId, table.payrollTransactionId],
    }),
    index("settlement_obligation_transactions_transaction_idx").on(
      table.payrollTransactionId,
    ),
    check(
      "settlement_obligation_transactions_amount_check",
      sql`${table.allocatedAmount} is null or ${table.allocatedAmount} > 0`,
    ),
  ],
);

/**
 * Append-only signed ledger activity. Positive amounts reduce an obligation's
 * balance; negative amounts add to it or explicitly undo prior activity.
 */
export const settlementEvents = pgTable(
  "settlement_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    settlementObligationId: uuid("settlement_obligation_id").references(
      () => settlementObligations.id,
    ),
    settlementBatchId: uuid("settlement_batch_id").references(() => settlementBatches.id),
    employeeId: uuid("employee_id").references(() => employees.id),
    individualId: uuid("individual_id").references(() => individuals.id),
    /** 'payment' | 'set_aside' | 'credit' | 'adjustment' | 'reversal' */
    eventType: text("event_type").notNull(),
    amount: numeric("amount", { precision: 14, scale: 4 }).notNull(),
    occurredOn: date("occurred_on").notNull(),
    reference: text("reference"),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    reversalOfEventId: uuid("reversal_of_event_id").references(
      (): AnyPgColumn => settlementEvents.id,
    ),
    createdAt: createdAt(),
  },
  (table) => [
    index("settlement_events_obligation_idx").on(
      table.settlementObligationId,
      table.occurredOn,
    ),
    index("settlement_events_employee_idx").on(table.employeeId, table.occurredOn),
    index("settlement_events_individual_idx").on(table.individualId, table.occurredOn),
    index("settlement_events_batch_idx").on(table.settlementBatchId),
    uniqueIndex("settlement_events_one_reversal_key")
      .on(table.reversalOfEventId)
      .where(sql`${table.reversalOfEventId} is not null`),
    check(
      "settlement_events_type_check",
      sql`${table.eventType} in ('payment', 'set_aside', 'credit', 'adjustment', 'reversal')`,
    ),
    check("settlement_events_amount_check", sql`${table.amount} <> 0`),
    check(
      "settlement_events_person_check",
      sql`(${table.employeeId} is not null) <> (${table.individualId} is not null)`,
    ),
    check(
      "settlement_events_unapplied_check",
      sql`${table.settlementObligationId} is not null or ${table.eventType} in ('credit', 'reversal')`,
    ),
    check(
      "settlement_events_reversal_check",
      sql`(${table.eventType} = 'reversal' and ${table.reversalOfEventId} is not null)
        or (${table.eventType} <> 'reversal' and ${table.reversalOfEventId} is null)`,
    ),
  ],
);

/** Global source version and dated refresh certification for settlement actions. */
export const settlementLedgerState = pgTable(
  "settlement_ledger_state",
  {
    singleton: boolean("singleton").primaryKey().default(true).notNull(),
    sourceVersion: bigint("source_version", { mode: "bigint" }).default(sql`1`).notNull(),
    refreshedVersion: bigint("refreshed_version", { mode: "bigint" }).default(sql`0`).notNull(),
    dirtySince: timestamp("dirty_since", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    refreshedForDate: date("refreshed_for_date"),
    lastRefreshError: text("last_refresh_error"),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("settlement_ledger_state_singleton_check", sql`${table.singleton}`),
    check(
      "settlement_ledger_state_versions_check",
      sql`${table.sourceVersion} >= 0 and ${table.refreshedVersion} >= 0 and ${table.refreshedVersion} <= ${table.sourceVersion}`,
    ),
  ],
);

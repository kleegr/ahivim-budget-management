import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  integer,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

export const individuals = pgTable(
  "individuals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normalizedName: text("normalized_name").notNull(),
    displayName: text("display_name").notNull(),
    externalRef: text("external_ref"),
    notes: text("notes"),
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

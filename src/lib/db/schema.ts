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
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  budgetAuthorizations,
  budgetPeriods,
  calculationStrategies,
  createdAt,
  employees,
  individuals,
  programs,
  programBudgetEvents,
  updatedAt,
  users,
} from "./schema-access";

export * from "./schema-access";

/**
 * Operational and financial schema tables. Identity, access, agency, program,
 * calculation, and budget tables live in schema-access.ts; schema.ts remains
 * the single public entrypoint consumed by Drizzle and the application.
 */

/** Owner-recorded income not present in the Google Sheet transaction ledger. */
export const agencyManualIncomeEntries = pgTable(
  "agency_manual_income_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceDate: date("service_date").notNull(),
    sourceType: text("source_type").notNull(),
    individualId: uuid("individual_id").references(() => individuals.id),
    programId: uuid("program_id").references(() => programs.id),
    grossAmount: numeric("gross_amount", { precision: 14, scale: 4 }).notNull(),
    agencySharePercent: numeric("agency_share_percent", { precision: 9, scale: 6 }).notNull(),
    agencyAmount: numeric("agency_amount", { precision: 14, scale: 4 }).notNull(),
    individualAmount: numeric("individual_amount", { precision: 14, scale: 4 }).notNull(),
    sourceRef: text("source_ref"),
    notes: text("notes"),
    programBudgetEventId: uuid("program_budget_event_id").references(() => programBudgetEvents.id),
    programBudgetReversalEventId: uuid("program_budget_reversal_event_id").references(() => programBudgetEvents.id),
    status: text("status").default("active").notNull(),
    voidReason: text("void_reason"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agency_manual_income_entries_source_ref_key")
      .on(table.sourceType, sql`lower(btrim(${table.sourceRef}))`)
      .where(sql`nullif(btrim(${table.sourceRef}), '') is not null`),
    index("agency_manual_income_entries_date_idx").on(table.serviceDate, table.status),
    index("agency_manual_income_entries_person_program_idx")
      .on(table.individualId, table.programId, table.serviceDate),
    check(
      "agency_manual_income_entries_type_check",
      sql`${table.sourceType} in ('class', 'reimbursement', 'custom_program', 'other')`,
    ),
    check("agency_manual_income_entries_gross_check", sql`${table.grossAmount} > 0`),
    check(
      "agency_manual_income_entries_share_check",
      sql`${table.agencySharePercent} between 0 and 1`,
    ),
    check(
      "agency_manual_income_entries_amounts_check",
      sql`${table.agencyAmount} >= 0 and ${table.individualAmount} >= 0
        and ${table.agencyAmount} + ${table.individualAmount} = ${table.grossAmount}`,
    ),
    check(
      "agency_manual_income_entries_custom_program_check",
      sql`${table.sourceType} <> 'custom_program'
        or (${table.individualId} is not null and ${table.programId} is not null)`,
    ),
    check(
      "agency_manual_income_entries_status_check",
      sql`${table.status} in ('active', 'void')`,
    ),
    check(
      "agency_manual_income_entries_void_check",
      sql`(${table.status} = 'active' and ${table.voidedAt} is null
          and ${table.voidedByUserId} is null and ${table.voidReason} is null)
        or (${table.status} = 'void' and ${table.voidedAt} is not null
          and ${table.voidedByUserId} is not null and length(btrim(${table.voidReason})) >= 5)`,
    ),
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

/** Canonical payroll facts for one employee check (0030). */
export const employeePayrollChecks = pgTable(
  "employee_payroll_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    checkNumber: text("check_number"),
    checkDate: date("check_date"),
    periodBegin: date("period_begin"),
    periodEnd: date("period_end"),
    actualGross: numeric("actual_gross", { precision: 14, scale: 4 }),
    actualNet: numeric("actual_net", { precision: 14, scale: 4 }).notNull(),
    taxWithheld: numeric("tax_withheld", { precision: 14, scale: 4 }),
    source: text("source").default("manual").notNull(),
    sourceRef: text("source_ref"),
    verificationStatus: text("verification_status").default("verified").notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("employee_payroll_checks_identity_key").on(
      table.employeeId,
      sql`coalesce(nullif(btrim(${table.checkNumber}), ''), '')`,
      sql`coalesce(${table.checkDate}, 'infinity'::date)`,
      sql`coalesce(${table.periodBegin}, 'infinity'::date)`,
      sql`coalesce(${table.periodEnd}, 'infinity'::date)`,
    ),
    index("employee_payroll_checks_employee_date_idx").on(
      table.employeeId,
      table.checkDate.desc(),
      table.periodEnd.desc(),
    ),
    check(
      "employee_payroll_checks_identity_check",
      sql`nullif(btrim(${table.checkNumber}), '') is not null
        or ${table.checkDate} is not null
        or ${table.periodBegin} is not null
        or ${table.periodEnd} is not null`,
    ),
    check(
      "employee_payroll_checks_period_check",
      sql`${table.periodEnd} is null or ${table.periodBegin} is null or ${table.periodEnd} >= ${table.periodBegin}`,
    ),
    check("employee_payroll_checks_gross_check", sql`${table.actualGross} is null or ${table.actualGross} >= 0`),
    check("employee_payroll_checks_net_check", sql`${table.actualNet} >= 0`),
    check("employee_payroll_checks_tax_check", sql`${table.taxWithheld} is null or ${table.taxWithheld} >= 0`),
    check(
      "employee_payroll_checks_source_check",
      sql`${table.source} in ('manual', 'import', 'sync', 'legacy_transaction')`,
    ),
    check(
      "employee_payroll_checks_verification_check",
      sql`${table.verificationStatus} in ('unverified', 'verified', 'void')`,
    ),
  ],
);

/** Manager-defined direct-pay gross targets, converted to planner-safe hours (0030). */
export const employeeDirectPayTargets = pgTable(
  "employee_direct_pay_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    targetBasis: text("target_basis").default("gross").notNull(),
    intervalUnit: text("interval_unit").default("week").notNull(),
    intervalCount: integer("interval_count").default(1).notNull(),
    grossTargetAmount: numeric("gross_target_amount", { precision: 14, scale: 4 }).notNull(),
    planningHourlyRate: numeric("planning_hourly_rate", { precision: 14, scale: 4 }).notNull(),
    targetHours: numeric("target_hours", { precision: 10, scale: 4 })
      .generatedAlwaysAs(sql`round("gross_target_amount" / "planning_hourly_rate", 4)`),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
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
    uniqueIndex("employee_direct_pay_targets_employee_effective_key")
      .on(table.employeeId, table.effectiveFrom)
      .where(sql`${table.status} = 'active'`),
    index("employee_direct_pay_targets_active_idx")
      .on(table.employeeId, table.effectiveFrom, table.effectiveTo)
      .where(sql`${table.status} = 'active'`),
    check("employee_direct_pay_targets_basis_check", sql`${table.targetBasis} = 'gross'`),
    check(
      "employee_direct_pay_targets_interval_unit_check",
      sql`${table.intervalUnit} in ('week', 'month', 'custom')`,
    ),
    check("employee_direct_pay_targets_interval_count_check", sql`${table.intervalCount} > 0`),
    check("employee_direct_pay_targets_amount_check", sql`${table.grossTargetAmount} > 0`),
    check("employee_direct_pay_targets_rate_check", sql`${table.planningHourlyRate} > 0`),
    check(
      "employee_direct_pay_targets_period_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "employee_direct_pay_targets_custom_period_check",
      sql`${table.intervalUnit} <> 'custom'
        or (${table.effectiveTo} is not null and ${table.intervalCount} = 1)`,
    ),
    check("employee_direct_pay_targets_status_check", sql`${table.status} in ('active', 'archived')`),
    check(
      "employee_direct_pay_targets_archive_state_check",
      sql`(${table.status} = 'archived') = (${table.archivedAt} is not null)`,
    ),
  ],
);

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
    payrollCheckId: uuid("payroll_check_id").references(() => employeePayrollChecks.id),
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
    index("payroll_transactions_payroll_check_idx")
      .on(table.payrollCheckId)
      .where(sql`${table.payrollCheckId} is not null`),
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
    /** Recurrence phase anchor; may precede a future version's effective start. */
    recurrenceAnchorDate: date("recurrence_anchor_date").notNull(),
    supersedesSeriesId: uuid("supersedes_series_id").references(
      (): AnyPgColumn => scheduleSeries.id,
      { onDelete: "set null" },
    ),
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
  (table) => [
    uniqueIndex("schedule_series_one_live_successor_key")
      .on(table.supersedesSeriesId)
      .where(sql`${table.supersedesSeriesId} is not null and ${table.archivedAt} is null`),
  ],
);

/** The current participant roster owned by a recurring schedule series. */
export const scheduleSeriesIndividuals = pgTable(
  "schedule_series_individuals",
  {
    seriesId: uuid("series_id")
      .notNull()
      .references(() => scheduleSeries.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "schedule_series_individuals_pk",
      columns: [table.seriesId, table.individualId],
    }),
    index("schedule_series_individuals_individual_idx").on(table.individualId),
  ],
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
    uniqueIndex("scheduled_sessions_one_transaction_match_key")
      .on(table.matchedTransactionId)
      .where(sql`${table.matchedTransactionId} is not null`),
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
    uniqueIndex("scheduled_allocations_one_individual_key").on(table.scheduledSessionId, table.individualId),
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

/** Effective-dated recurring hours declared for an employee. */
export const employeeWeeklyAvailability = pgTable(
  "employee_weekly_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    /** 0=Sunday..6=Saturday. */
    weekday: integer("weekday").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("employee_weekly_availability_active_lookup_idx")
      .on(table.employeeId, table.effectiveFrom, table.effectiveTo, table.weekday)
      .where(sql`${table.archivedAt} is null`),
    check("employee_weekly_availability_weekday_check", sql`${table.weekday} between 0 and 6`),
    check(
      "employee_weekly_availability_start_time_check",
      sql`${table.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "employee_weekly_availability_end_time_check",
      sql`${table.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check("employee_weekly_availability_time_order_check", sql`${table.startTime} < ${table.endTime}`),
    check(
      "employee_weekly_availability_date_order_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "employee_weekly_availability_archive_check",
      sql`(${table.archivedAt} is null and ${table.archivedByUserId} is null) or ${table.archivedAt} is not null`,
    ),
  ],
);

/** A full-day or timed exception that overrides recurring availability. */
export const employeeUnavailability = pgTable(
  "employee_unavailability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    label: text("label"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("employee_unavailability_active_lookup_idx")
      .on(table.employeeId, table.startDate, table.endDate)
      .where(sql`${table.archivedAt} is null`),
    check("employee_unavailability_date_order_check", sql`${table.endDate} >= ${table.startDate}`),
    check(
      "employee_unavailability_time_pair_check",
      sql`(${table.startTime} is null and ${table.endTime} is null) or (${table.startTime} is not null and ${table.endTime} is not null)`,
    ),
    check(
      "employee_unavailability_start_time_check",
      sql`${table.startTime} is null or ${table.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "employee_unavailability_end_time_check",
      sql`${table.endTime} is null or ${table.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "employee_unavailability_time_order_check",
      sql`${table.startTime} is null or ${table.startTime} < ${table.endTime}`,
    ),
    check(
      "employee_unavailability_timed_single_day_check",
      sql`${table.startTime} is null or ${table.startDate} = ${table.endDate}`,
    ),
    check(
      "employee_unavailability_archive_check",
      sql`(${table.archivedAt} is null and ${table.archivedByUserId} is null) or ${table.archivedAt} is not null`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Class revenue and invoicing (0025)                                         */
/* -------------------------------------------------------------------------- */

export const classActivities = pgTable(
  "class_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultUnitPrice: numeric("default_unit_price", { precision: 14, scale: 4 })
      .default("150")
      .notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("class_activities_code_key").on(sql`lower(${table.code})`),
    index("class_activities_active_idx").on(table.isActive, table.sortOrder, table.name),
    check("class_activities_code_check", sql`length(btrim(${table.code})) > 0`),
    check("class_activities_name_check", sql`length(btrim(${table.name})) > 0`),
    check("class_activities_price_check", sql`${table.defaultUnitPrice} >= 0`),
  ],
);

export const classBudgetPeriods = pgTable(
  "class_budget_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    label: text("label").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    authorizedAmount: numeric("authorized_amount", { precision: 14, scale: 4 }).notNull(),
    /** Canonical service-program budget links (0028); nullable for legacy repair. */
    programId: uuid("program_id").references(() => programs.id),
    budgetPeriodId: uuid("budget_period_id").references(() => budgetPeriods.id),
    budgetAuthorizationId: uuid("budget_authorization_id").references(() => budgetAuthorizations.id),
    /** 'active' | 'closed' */
    status: text("status").default("active").notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("class_budget_periods_exact_active_key")
      .on(table.individualId, table.startDate, table.endDate)
      .where(sql`${table.status} = 'active'`),
    index("class_budget_periods_individual_idx").on(
      table.individualId,
      table.status,
      table.startDate,
      table.endDate,
    ),
    check("class_budget_periods_label_check", sql`length(btrim(${table.label})) > 0`),
    check("class_budget_periods_range_check", sql`${table.endDate} >= ${table.startDate}`),
    check("class_budget_periods_amount_check", sql`${table.authorizedAmount} >= 0`),
    check("class_budget_periods_status_check", sql`${table.status} in ('active', 'closed')`),
  ],
);

export const classInvoices = pgTable(
  "class_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classBudgetPeriodId: uuid("class_budget_period_id")
      .notNull()
      .references(() => classBudgetPeriods.id),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    servicePeriodStart: date("service_period_start").notNull(),
    servicePeriodEnd: date("service_period_end").notNull(),
    billToName: text("bill_to_name").notNull(),
    billToAddressLine1: text("bill_to_address_line_1"),
    billToAddressLine2: text("bill_to_address_line_2"),
    billToCityStateZip: text("bill_to_city_state_zip"),
    purpose: text("purpose").default("CLASSES").notNull(),
    notes: text("notes"),
    /** 'draft' | 'issued' | 'void' */
    status: text("status").default("draft").notNull(),
    subtotal: numeric("subtotal", { precision: 14, scale: 4 }).default("0").notNull(),
    discountTotal: numeric("discount_total", { precision: 14, scale: 4 }).default("0").notNull(),
    totalAmount: numeric("total_amount", { precision: 14, scale: 4 }).default("0").notNull(),
    budgetAuthorizedSnapshot: numeric("budget_authorized_snapshot", { precision: 14, scale: 4 }),
    budgetConsumedBeforeSnapshot: numeric("budget_consumed_before_snapshot", { precision: 14, scale: 4 }),
    budgetOverageSnapshot: numeric("budget_overage_snapshot", { precision: 14, scale: 4 }),
    overBudgetOverrideReason: text("over_budget_override_reason"),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("class_invoices_number_key").on(sql`lower(${table.invoiceNumber})`),
    index("class_invoices_individual_idx").on(table.individualId, table.status, table.invoiceDate),
    index("class_invoices_budget_idx").on(table.classBudgetPeriodId, table.status, table.invoiceDate),
    check("class_invoices_number_check", sql`length(btrim(${table.invoiceNumber})) > 0`),
    check("class_invoices_bill_to_check", sql`length(btrim(${table.billToName})) > 0`),
    check("class_invoices_purpose_check", sql`length(btrim(${table.purpose})) > 0`),
    check("class_invoices_date_check", sql`extract(dow from ${table.invoiceDate}) <> 6`),
    check("class_invoices_period_check", sql`${table.servicePeriodEnd} >= ${table.servicePeriodStart}`),
    check(
      "class_invoices_totals_check",
      sql`${table.subtotal} >= 0 and ${table.discountTotal} >= 0 and ${table.totalAmount} >= 0
        and ${table.totalAmount} = ${table.subtotal} - ${table.discountTotal}`,
    ),
    check("class_invoices_status_check", sql`${table.status} in ('draft', 'issued', 'void')`),
    check(
      "class_invoices_lifecycle_check",
      sql`(${table.status} = 'draft' and ${table.issuedAt} is null and ${table.voidedAt} is null)
        or (${table.status} = 'issued' and ${table.issuedAt} is not null
          and ${table.issuedByUserId} is not null and ${table.voidedAt} is null
          and ${table.voidedByUserId} is null and ${table.voidReason} is null
          and ${table.budgetAuthorizedSnapshot} is not null
          and ${table.budgetConsumedBeforeSnapshot} is not null
          and ${table.budgetOverageSnapshot} is not null)
        or (${table.status} = 'void' and ${table.issuedAt} is not null
          and ${table.issuedByUserId} is not null and ${table.voidedAt} is not null
          and ${table.voidedByUserId} is not null and length(btrim(${table.voidReason})) > 0
          and ${table.budgetAuthorizedSnapshot} is not null
          and ${table.budgetConsumedBeforeSnapshot} is not null
          and ${table.budgetOverageSnapshot} is not null)`,
    ),
  ],
);

export const classInvoiceLines = pgTable(
  "class_invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classInvoiceId: uuid("class_invoice_id").notNull().references(() => classInvoices.id),
    classActivityId: uuid("class_activity_id").references(() => classActivities.id),
    serviceDate: date("service_date").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 4 }).default("1").notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).default("150").notNull(),
    discountAmount: numeric("discount_amount", { precision: 14, scale: 4 }).default("0").notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 4 }).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("class_invoice_lines_invoice_idx").on(table.classInvoiceId, table.sortOrder, table.serviceDate),
    index("class_invoice_lines_activity_idx").on(table.classActivityId),
    check("class_invoice_lines_description_check", sql`length(btrim(${table.description})) > 0`),
    check("class_invoice_lines_saturday_check", sql`extract(dow from ${table.serviceDate}) <> 6`),
    check("class_invoice_lines_quantity_check", sql`${table.quantity} > 0`),
    check("class_invoice_lines_price_check", sql`${table.unitPrice} >= 0`),
    check(
      "class_invoice_lines_discount_check",
      sql`${table.discountAmount} >= 0 and ${table.discountAmount} <= round(${table.quantity} * ${table.unitPrice}, 4)`,
    ),
    check(
      "class_invoice_lines_total_check",
      sql`${table.lineTotal} = round(${table.quantity} * ${table.unitPrice} - ${table.discountAmount}, 4)
        and ${table.lineTotal} >= 0`,
    ),
  ],
);

export const classBudgetLedger = pgTable(
  "class_budget_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classBudgetPeriodId: uuid("class_budget_period_id")
      .notNull()
      .references(() => classBudgetPeriods.id),
    classInvoiceId: uuid("class_invoice_id").notNull().references(() => classInvoices.id),
    /** 'issue' | 'void' */
    eventType: text("event_type").notNull(),
    amount: numeric("amount", { precision: 14, scale: 4 }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("class_budget_ledger_invoice_event_key").on(table.classInvoiceId, table.eventType),
    index("class_budget_ledger_budget_idx").on(table.classBudgetPeriodId, table.createdAt),
    check("class_budget_ledger_event_check", sql`${table.eventType} in ('issue', 'void')`),
    check(
      "class_budget_ledger_sign_check",
      sql`(${table.eventType} = 'issue' and ${table.amount} > 0)
        or (${table.eventType} = 'void' and ${table.amount} < 0)`,
    ),
  ],
);

export const classReimbursementProfiles = pgTable(
  "class_reimbursement_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    mailingName: text("mailing_name"),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    cityStateZip: text("city_state_zip"),
    phone: text("phone"),
    dateOfBirth: date("date_of_birth"),
    medicaidId: text("medicaid_id"),
    fiscalIntermediary: text("fiscal_intermediary").default("Ahivim").notNull(),
    payableTo: text("payable_to").default("Xcellent Staffing").notNull(),
    lifePlanConfirmed: boolean("life_plan_confirmed").default(false).notNull(),
    budgetCategory: text("budget_category").default("Community classes").notNull(),
    formCompletedBy: text("form_completed_by"),
    relationship: text("relationship"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("class_reimbursement_profiles_individual_key").on(table.individualId),
    index("class_reimbursement_profiles_individual_idx").on(table.individualId),
    check("class_reimbursement_profiles_fi_check", sql`length(btrim(${table.fiscalIntermediary})) > 0`),
    check("class_reimbursement_profiles_payable_check", sql`length(btrim(${table.payableTo})) > 0`),
    check("class_reimbursement_profiles_category_check", sql`length(btrim(${table.budgetCategory})) > 0`),
  ],
);

export const classCoverSheetSnapshots = pgTable(
  "class_cover_sheet_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classInvoiceId: uuid("class_invoice_id").notNull().references(() => classInvoices.id),
    profileSnapshot: jsonb("profile_snapshot").$type<Record<string, unknown>>().notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("class_cover_sheet_snapshots_invoice_key").on(table.classInvoiceId)],
);

/* -------------------------------------------------------------------------- */
/* Document library                                                           */
/* -------------------------------------------------------------------------- */

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").default("general").notNull(),
    /** 'uploading' | 'active' | 'archived' */
    status: text("status").default("uploading").notNull(),
    originalVersionId: uuid("original_version_id"),
    currentVersionId: uuid("current_version_id"),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").notNull().references(() => users.id),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("documents_status_updated_idx").on(table.status, table.updatedAt, table.id),
    index("documents_creator_idx").on(table.createdByUserId, table.updatedAt),
    check("documents_title_check", sql`length(btrim(${table.title})) between 1 and 180`),
    check("documents_category_check", sql`length(btrim(${table.category})) between 1 and 80`),
    check("documents_status_check", sql`${table.status} in ('uploading', 'active', 'archived')`),
    check(
      "documents_archive_check",
      sql`(${table.status} = 'archived' and ${table.archivedAt} is not null)
        or (${table.status} <> 'archived' and ${table.archivedAt} is null and ${table.archivedByUserId} is null)`,
    ),
  ],
);

export const documentBlobs = pgTable(
  "document_blobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    /** 'original' | 'edited' */
    purpose: text("purpose").notNull(),
    storagePathname: text("storage_pathname").notNull(),
    storageEtag: text("storage_etag").notNull(),
    contentType: text("content_type").default("application/pdf").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    filename: text("filename").notNull(),
    checksumSha256: text("checksum_sha256"),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("document_blobs_pathname_key").on(table.storagePathname),
    uniqueIndex("document_blobs_document_id_key").on(table.documentId, table.id),
    index("document_blobs_document_idx").on(table.documentId, table.createdAt),
    check("document_blobs_purpose_check", sql`${table.purpose} in ('original', 'edited')`),
    check("document_blobs_pdf_check", sql`${table.contentType} = 'application/pdf'`),
    check("document_blobs_size_check", sql`${table.byteSize} > 0`),
    check("document_blobs_filename_check", sql`length(btrim(${table.filename})) between 1 and 255`),
    check(
      "document_blobs_checksum_check",
      sql`${table.checksumSha256} is null or ${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /** 'original' | 'saved' | 'restored' */
    versionKind: text("version_kind").notNull(),
    parentVersionId: uuid("parent_version_id").references((): AnyPgColumn => documentVersions.id),
    restoredFromVersionId: uuid("restored_from_version_id").references(
      (): AnyPgColumn => documentVersions.id,
    ),
    sourceBlobId: uuid("source_blob_id").notNull().references(() => documentBlobs.id),
    outputBlobId: uuid("output_blob_id").notNull().references(() => documentBlobs.id),
    /** 'source' | 'standard' | 'secure' */
    exportMode: text("export_mode").default("standard").notNull(),
    editorSchemaVersion: integer("editor_schema_version").default(1).notNull(),
    editorState: jsonb("editor_state").$type<Record<string, unknown>>().default({}).notNull(),
    pageCount: integer("page_count"),
    changeSummary: text("change_summary"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("document_versions_document_number_key").on(table.documentId, table.versionNumber),
    uniqueIndex("document_versions_document_id_key").on(table.documentId, table.id),
    uniqueIndex("document_versions_idempotency_key").on(table.documentId, table.idempotencyKey),
    index("document_versions_document_created_idx").on(table.documentId, table.createdAt, table.id),
    foreignKey({
      name: "document_versions_parent_document_fk",
      columns: [table.documentId, table.parentVersionId],
      foreignColumns: [table.documentId, table.id],
    }),
    foreignKey({
      name: "document_versions_restore_document_fk",
      columns: [table.documentId, table.restoredFromVersionId],
      foreignColumns: [table.documentId, table.id],
    }),
    foreignKey({
      name: "document_versions_source_blob_document_fk",
      columns: [table.documentId, table.sourceBlobId],
      foreignColumns: [documentBlobs.documentId, documentBlobs.id],
    }),
    foreignKey({
      name: "document_versions_output_blob_document_fk",
      columns: [table.documentId, table.outputBlobId],
      foreignColumns: [documentBlobs.documentId, documentBlobs.id],
    }),
    check("document_versions_number_check", sql`${table.versionNumber} > 0`),
    check("document_versions_kind_check", sql`${table.versionKind} in ('original', 'saved', 'restored')`),
    check("document_versions_export_check", sql`${table.exportMode} in ('source', 'standard', 'secure')`),
    check("document_versions_editor_schema_check", sql`${table.editorSchemaVersion} > 0`),
    check("document_versions_page_count_check", sql`${table.pageCount} is null or ${table.pageCount} > 0`),
    check(
      "document_versions_original_check",
      sql`(${table.versionKind} = 'original' and ${table.versionNumber} = 1
        and ${table.parentVersionId} is null and ${table.restoredFromVersionId} is null
        and ${table.sourceBlobId} = ${table.outputBlobId} and ${table.exportMode} = 'source')
        or ${table.versionKind} <> 'original'`,
    ),
    check(
      "document_versions_restore_check",
      sql`(${table.versionKind} = 'restored' and ${table.restoredFromVersionId} is not null)
        or (${table.versionKind} <> 'restored' and ${table.restoredFromVersionId} is null)`,
    ),
  ],
);

export const documentDrafts = pgTable(
  "document_drafts",
  {
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id").notNull(),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
    editorSchemaVersion: integer("editor_schema_version").default(1).notNull(),
    editorState: jsonb("editor_state").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.userId] }),
    index("document_drafts_user_updated_idx").on(table.userId, table.updatedAt),
    foreignKey({
      name: "document_drafts_version_fk",
      columns: [table.documentId, table.baseVersionId],
      foreignColumns: [documentVersions.documentId, documentVersions.id],
    }),
    check("document_drafts_revision_check", sql`${table.revision} > 0`),
    check("document_drafts_editor_schema_check", sql`${table.editorSchemaVersion} > 0`),
  ],
);

export const documentUploadIntents = pgTable(
  "document_upload_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    /** 'original' | 'version' */
    purpose: text("purpose").notNull(),
    /** 'pending' | 'uploaded' | 'finalized' | 'expired' */
    status: text("status").default("pending").notNull(),
    reservedPathname: text("reserved_pathname").notNull(),
    filename: text("filename").notNull(),
    expectedByteSize: bigint("expected_byte_size", { mode: "number" }).notNull(),
    baseVersionId: uuid("base_version_id"),
    storagePathname: text("storage_pathname"),
    storageEtag: text("storage_etag"),
    uploadedContentType: text("uploaded_content_type"),
    uploadedByteSize: bigint("uploaded_byte_size", { mode: "number" }),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedVersionId: uuid("finalized_version_id").references(() => documentVersions.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("document_upload_intents_pathname_key").on(table.reservedPathname),
    index("document_upload_intents_document_idx").on(table.documentId, table.createdAt),
    index("document_upload_intents_expiry_idx").on(table.status, table.expiresAt),
    foreignKey({
      name: "document_upload_intents_base_version_fk",
      columns: [table.documentId, table.baseVersionId],
      foreignColumns: [documentVersions.documentId, documentVersions.id],
    }),
    foreignKey({
      name: "document_upload_intents_finalized_version_document_fk",
      columns: [table.documentId, table.finalizedVersionId],
      foreignColumns: [documentVersions.documentId, documentVersions.id],
    }),
    check("document_upload_intents_purpose_check", sql`${table.purpose} in ('original', 'version')`),
    check(
      "document_upload_intents_status_check",
      sql`${table.status} in ('pending', 'uploaded', 'finalized', 'expired')`,
    ),
    check(
      "document_upload_intents_filename_check",
      sql`length(btrim(${table.filename})) between 1 and 255`,
    ),
    check("document_upload_intents_size_check", sql`${table.expectedByteSize} > 0`),
    check(
      "document_upload_intents_uploaded_size_check",
      sql`${table.uploadedByteSize} is null or ${table.uploadedByteSize} > 0`,
    ),
  ],
);

import {
  type AnyPgColumn,
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

export const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

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
    /** Business-facing preset identity; nullable for pre-preset viewer accounts. */
    accountPreset: text("account_preset"),
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
    /** May create, reverse, or refresh settlement and collection records. */
    canManageSettlements: boolean("can_manage_settlements").default(false).notNull(),
    /** Operational planning permission (mirror of drizzle/0021_planner_access.sql). */
    canPlan: boolean("can_plan").default(false).notNull(),
    /** Class revenue is financial and remains separate from hours-only planning. */
    canSeeClassFinancials: boolean("can_see_class_financials").default(false).notNull(),
    canManageClassInvoices: boolean("can_manage_class_invoices").default(false).notNull(),
    /** May use the source-preserving PDF editing workspace. */
    canEditDocuments: boolean("can_edit_documents").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("users_email_key").on(table.email),
    check(
      "users_account_preset_check",
      sql`${table.accountPreset} is null or ${table.accountPreset} in (
        'owner', 'office_manager', 'budget_planner', 'staffing_manager',
        'money_collector', 'class_billing', 'individual_parent', 'employee',
        'agency', 'agency_scheduler', 'agency_staffing_manager',
        'agency_collector', 'custom_access'
      )`,
    ),
  ],
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

/* -------------------------------------------------------------------------- */
/* Agencies and portal authorization (0029)                                  */
/* -------------------------------------------------------------------------- */

export const agencies = pgTable(
  "agencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** 'active' | 'inactive' | 'archived' */
    status: text("status").default("active").notNull(),
    isHomeAgency: boolean("is_home_agency").default(false).notNull(),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agencies_code_key").on(sql`lower(${table.code})`),
    uniqueIndex("agencies_single_home_key")
      .on(table.isHomeAgency)
      .where(sql`${table.isHomeAgency} = true`),
    index("agencies_status_name_idx").on(table.status, table.name),
    check("agencies_code_check", sql`length(btrim(${table.code})) > 0`),
    check("agencies_name_check", sql`length(btrim(${table.name})) > 0`),
    check("agencies_status_check", sql`${table.status} in ('active', 'inactive', 'archived')`),
  ],
);

export const userPortalRoles = pgTable(
  "user_portal_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Installation roles only. Agency-scoped roles live in user_agency_access. */
    portalRole: text("portal_role").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    capabilityGrants: text("capability_grants").array().default(sql`ARRAY[]::text[]`).notNull(),
    capabilityDenials: text("capability_denials").array().default(sql`ARRAY[]::text[]`).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.portalRole] }),
    index("user_portal_roles_active_idx").on(table.userId, table.isActive, table.portalRole),
    check(
      "user_portal_roles_role_check",
      sql`${table.portalRole} in ('owner', 'individual', 'parent', 'employee')`,
    ),
  ],
);

export const userAgencyAccess = pgTable(
  "user_agency_access",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
    portalRole: text("portal_role").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    capabilityGrants: text("capability_grants").array().default(sql`ARRAY[]::text[]`).notNull(),
    capabilityDenials: text("capability_denials").array().default(sql`ARRAY[]::text[]`).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.agencyId, table.portalRole] }),
    index("user_agency_access_user_idx").on(table.userId, table.isActive, table.agencyId),
    index("user_agency_access_agency_idx").on(table.agencyId, table.isActive, table.portalRole),
    check(
      "user_agency_access_role_check",
      sql`${table.portalRole} in ('agency', 'staffing_manager', 'scheduler', 'collector')`,
    ),
  ],
);

export const userIndividualRelationships = pgTable(
  "user_individual_relationships",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id").notNull().references(() => individuals.id, { onDelete: "cascade" }),
    relationshipType: text("relationship_type").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    capabilityGrants: text("capability_grants").array().default(sql`ARRAY[]::text[]`).notNull(),
    capabilityDenials: text("capability_denials").array().default(sql`ARRAY[]::text[]`).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.individualId, table.relationshipType] }),
    index("user_individual_relationships_user_idx").on(table.userId, table.isActive, table.individualId),
    index("user_individual_relationships_individual_idx").on(table.individualId, table.isActive, table.userId),
    check(
      "user_individual_relationships_type_check",
      sql`${table.relationshipType} in ('self', 'parent', 'guardian', 'representative')`,
    ),
  ],
);

export const userEmployeeRelationships = pgTable(
  "user_employee_relationships",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    relationshipType: text("relationship_type").default("self").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    capabilityGrants: text("capability_grants").array().default(sql`ARRAY[]::text[]`).notNull(),
    capabilityDenials: text("capability_denials").array().default(sql`ARRAY[]::text[]`).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.employeeId, table.relationshipType] }),
    index("user_employee_relationships_user_idx").on(table.userId, table.isActive, table.employeeId),
    index("user_employee_relationships_employee_idx").on(table.employeeId, table.isActive, table.userId),
    check("user_employee_relationships_type_check", sql`${table.relationshipType} in ('self')`),
  ],
);

export const agencyIndividuals = pgTable(
  "agency_individuals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
    individualId: uuid("individual_id").notNull().references(() => individuals.id, { onDelete: "cascade" }),
    managesBudget: boolean("manages_budget").default(false).notNull(),
    billsServices: boolean("bills_services").default(true).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    effectiveFrom: date("effective_from")
      .default(sql`(now() at time zone 'America/New_York')::date`)
      .notNull(),
    effectiveTo: date("effective_to"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agency_individuals_agency_idx").on(
      table.agencyId,
      table.isActive,
      table.individualId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    index("agency_individuals_individual_idx").on(
      table.individualId,
      table.isActive,
      table.agencyId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    index("agency_individuals_budget_idx")
      .on(table.agencyId, table.managesBudget, table.billsServices)
      .where(sql`${table.isActive} = true`),
    check(
      "agency_individuals_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
  ],
);

export const agencyEmployees = pgTable(
  "agency_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    isActive: boolean("is_active").default(true).notNull(),
    effectiveFrom: date("effective_from")
      .default(sql`(now() at time zone 'America/New_York')::date`)
      .notNull(),
    effectiveTo: date("effective_to"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agency_employees_agency_idx").on(
      table.agencyId,
      table.isActive,
      table.employeeId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    index("agency_employees_employee_idx").on(
      table.employeeId,
      table.isActive,
      table.agencyId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    check(
      "agency_employees_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
  ],
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
    /** Catalog/billing metadata (0028). Category is intentionally configurable. */
    serviceCategory: text("service_category").default("direct_service").notNull(),
    paymentRecipient: text("payment_recipient").default("agency").notNull(),
    consumptionSource: text("consumption_source").default("payroll").notNull(),
    rateScope: text("rate_scope").default("per_individual").notNull(),
    renewalPolicy: text("renewal_policy").default("individual").notNull(),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("programs_code_key").on(table.code),
    check(
      "programs_payment_recipient_check",
      sql`${table.paymentRecipient} in ('agency', 'employee', 'external', 'not_applicable')`,
    ),
    check(
      "programs_consumption_source_check",
      sql`${table.consumptionSource} in ('payroll', 'invoice', 'manual', 'mixed')`,
    ),
    check("programs_rate_scope_check", sql`${table.rateScope} in ('per_individual', 'per_group', 'flat')`),
    check(
      "programs_renewal_policy_check",
      sql`${table.renewalPolicy} in ('individual', 'calendar', 'rolling', 'custom')`,
    ),
    check("programs_required_auth_type_check", sql`${table.requiredAuthType} in ('hours', 'dollars', 'both')`),
  ],
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
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("program_rate_schedules_program_effective_key").on(table.programId, table.effectiveFrom),
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
    status: text("status").default("active").notNull(),
    source: text("source"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
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
    /** Effective employee/internal rate in force for this authorization revision. */
    internalRate: numeric("internal_rate", { precision: 14, scale: 4 }).notNull(),
    rateOverride: boolean("rate_override").default(false).notNull(),
    sourceRowRef: text("source_row_ref"),
    revision: integer("revision").default(1).notNull(),
    supersedesId: uuid("supersedes_id"),
    status: text("status").default("active").notNull(),
    authorizedDollars: numeric("authorized_dollars", { precision: 14, scale: 4 }),
    /** Effective funder/agency rate, kept separate from the employee rate. */
    agencyRate: numeric("agency_rate", { precision: 14, scale: 4 }),
    /** Set when the effective employee rate differs from the catalog default. */
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
    uniqueIndex("budget_auth_active_period_program_key")
      .on(table.budgetPeriodId, table.programId)
      .where(sql`${table.status} = 'active'`),
    index("budget_auth_individual_idx").on(table.individualId),
  ],
);

/**
 * Signed, append-only consumption for invoice/manual programs and corrections.
 * Payroll remains authoritative and is unioned in the balance read model.
 */
export const programBudgetEvents = pgTable(
  "program_budget_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetPeriodId: uuid("budget_period_id").notNull().references(() => budgetPeriods.id),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    programId: uuid("program_id").notNull().references(() => programs.id),
    /** 'consume' | 'adjust' | 'reverse' */
    eventType: text("event_type").notNull(),
    serviceDate: date("service_date").notNull(),
    hours: numeric("hours", { precision: 10, scale: 4 }).default("0").notNull(),
    amount: numeric("amount", { precision: 14, scale: 4 }).default("0").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    reversesEventId: uuid("reverses_event_id").references(
      (): AnyPgColumn => programBudgetEvents.id,
    ),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("program_budget_events_source_key").on(
      table.sourceType,
      table.sourceId,
      table.eventType,
    ),
    uniqueIndex("program_budget_events_one_reversal_key")
      .on(table.reversesEventId)
      .where(sql`${table.reversesEventId} is not null`),
    index("program_budget_events_budget_idx").on(
      table.budgetPeriodId,
      table.programId,
      table.serviceDate,
      table.createdAt,
    ),
    index("program_budget_events_individual_idx").on(table.individualId, table.serviceDate),
    check("program_budget_events_type_check", sql`${table.eventType} in ('consume', 'adjust', 'reverse')`),
    check(
      "program_budget_events_value_check",
      sql`(${table.eventType} = 'consume' and ${table.hours} >= 0 and ${table.amount} >= 0
            and (${table.hours} > 0 or ${table.amount} > 0))
        or (${table.eventType} = 'adjust' and (${table.hours} <> 0 or ${table.amount} <> 0))
        or (${table.eventType} = 'reverse' and (${table.hours} <> 0 or ${table.amount} <> 0))`,
    ),
    check(
      "program_budget_events_reverse_link_check",
      sql`(${table.eventType} = 'reverse') = (${table.reversesEventId} is not null)`,
    ),
  ],
);

/** Effective-dated split for non-payroll revenue assigned to one person/program. */
export const individualProgramRevenueTerms = pgTable(
  "individual_program_revenue_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    programId: uuid("program_id").notNull().references(() => programs.id),
    agencySharePercent: numeric("agency_share_percent", { precision: 9, scale: 6 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    revision: integer("revision").default(1).notNull(),
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
    uniqueIndex("individual_program_revenue_terms_active_key")
      .on(table.individualId, table.programId, table.effectiveFrom)
      .where(sql`${table.status} = 'active'`),
    index("individual_program_revenue_terms_lookup_idx")
      .on(table.individualId, table.programId, table.effectiveFrom, table.effectiveTo)
      .where(sql`${table.status} = 'active'`),
    check(
      "individual_program_revenue_terms_share_check",
      sql`${table.agencySharePercent} between 0 and 1`,
    ),
    check(
      "individual_program_revenue_terms_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check("individual_program_revenue_terms_revision_check", sql`${table.revision} > 0`),
    check(
      "individual_program_revenue_terms_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "individual_program_revenue_terms_archive_check",
      sql`(${table.status} = 'archived') = (${table.archivedAt} is not null)`,
    ),
  ],
);

/** Employee share of the internal/base amount for one employee/person pairing. */
export const employeeIndividualCompensationTerms = pgTable(
  "employee_individual_compensation_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    individualId: uuid("individual_id").notNull().references(() => individuals.id),
    employeeSharePercent: numeric("employee_share_percent", { precision: 9, scale: 6 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    revision: integer("revision").default(1).notNull(),
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
    uniqueIndex("employee_individual_compensation_terms_active_key")
      .on(table.employeeId, table.individualId, table.effectiveFrom)
      .where(sql`${table.status} = 'active'`),
    index("employee_individual_compensation_terms_lookup_idx")
      .on(table.employeeId, table.individualId, table.effectiveFrom, table.effectiveTo)
      .where(sql`${table.status} = 'active'`),
    check(
      "employee_individual_compensation_terms_share_check",
      sql`${table.employeeSharePercent} between 0 and 1`,
    ),
    check(
      "employee_individual_compensation_terms_range_check",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check("employee_individual_compensation_terms_revision_check", sql`${table.revision} > 0`),
    check(
      "employee_individual_compensation_terms_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "employee_individual_compensation_terms_archive_check",
      sql`(${table.status} = 'archived') = (${table.archivedAt} is not null)`,
    ),
  ],
);

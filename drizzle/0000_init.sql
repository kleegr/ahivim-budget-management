CREATE TABLE "account_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_period_id" uuid NOT NULL,
  "field" text NOT NULL,
  "previous_value" text,
  "new_value" text,
  "reason" text,
  "adjusted_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_configurations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL,
  "first_cut_percent" numeric(9, 6) DEFAULT '0' NOT NULL,
  "second_cut_percent" numeric(9, 6) DEFAULT '0' NOT NULL,
  "notes" text,
  "unresolved_column_s" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL,
  "budget_period_id" uuid,
  "gross_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
  "first_cut_percent" numeric(9, 6) DEFAULT '0' NOT NULL,
  "first_cut_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
  "remaining_after_first_cut" numeric(14, 4) DEFAULT '0' NOT NULL,
  "second_cut_percent" numeric(9, 6) DEFAULT '0' NOT NULL,
  "second_cut_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
  "remaining_after_second_cut" numeric(14, 4) DEFAULT '0' NOT NULL,
  "third_cut_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
  "third_cut_is_manual" boolean DEFAULT false NOT NULL,
  "employee_cash_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "action" text NOT NULL,
  "entity_type" text,
  "entity_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "budget_period_id" uuid NOT NULL,
  "individual_id" uuid NOT NULL,
  "program_id" uuid NOT NULL,
  "authorized_hours" numeric(10, 4) NOT NULL,
  "internal_rate" numeric(14, 4) NOT NULL,
  "rate_override" boolean DEFAULT false NOT NULL,
  "source_row_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL,
  "label" text NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "planning_months" numeric(6, 3),
  "is_partial_period" boolean DEFAULT false NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL,
  "normalized_alias" text NOT NULL,
  "source_text" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "approved_by_user_id" uuid,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "normalized_name" text NOT NULL,
  "display_name" text NOT NULL,
  "external_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "imported_file_id" uuid NOT NULL,
  "status" text DEFAULT 'staged' NOT NULL,
  "started_by_user_id" uuid,
  "committed_by_user_id" uuid,
  "committed_at" timestamp with time zone,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "valid_rows" integer DEFAULT 0 NOT NULL,
  "imported_rows" integer DEFAULT 0 NOT NULL,
  "skipped_rows" integer DEFAULT 0 NOT NULL,
  "duplicate_rows" integer DEFAULT 0 NOT NULL,
  "warning_rows" integer DEFAULT 0 NOT NULL,
  "error_rows" integer DEFAULT 0 NOT NULL,
  "source_agency_gross" numeric(14, 4),
  "imported_agency_gross" numeric(14, 4),
  "source_internal_amount" numeric(14, 4),
  "imported_internal_amount" numeric(14, 4),
  "reconciliation_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_batch_id" uuid NOT NULL,
  "sheet_name" text NOT NULL,
  "source_row_number" integer NOT NULL,
  "raw_values" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "validation_errors" jsonb,
  "resolved_individual_id" uuid,
  "resolved_employee_id" uuid,
  "resolved_program_id" uuid,
  "transaction_fingerprint" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_warnings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_batch_id" uuid NOT NULL,
  "import_row_id" uuid,
  "individual_id" uuid,
  "category" text NOT NULL,
  "severity" text DEFAULT 'warning' NOT NULL,
  "message" text NOT NULL,
  "details" jsonb,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "original_filename" text NOT NULL,
  "byte_size" integer NOT NULL,
  "checksum_sha256" text NOT NULL,
  "uploaded_by_user_id" uuid,
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "template_detected" text,
  "sheet_summary" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "individual_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL,
  "normalized_alias" text NOT NULL,
  "source_text" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "approved_by_user_id" uuid,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "individuals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "normalized_name" text NOT NULL,
  "display_name" text NOT NULL,
  "external_ref" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_batch_id" uuid,
  "import_row_id" uuid,
  "source_file_id" uuid,
  "source_row_number" integer,
  "pay_to_raw" text,
  "check_number" text,
  "check_date" date,
  "period_begin" date,
  "period_end" date,
  "individual_id" uuid,
  "employee_id" uuid,
  "program_id" uuid,
  "individual_raw" text,
  "employee_raw" text,
  "program_raw" text,
  "imported_hours" numeric(10, 4),
  "imported_rate" numeric(14, 4),
  "imported_amount" numeric(14, 4),
  "total_net_pay" numeric(14, 4),
  "spreadsheet_internal_amount" numeric(14, 4),
  "calculated_internal_amount" numeric(14, 4),
  "internal_rate_applied" numeric(14, 4),
  "agency_rate_applied" numeric(14, 4),
  "internal_amount_mismatch" boolean DEFAULT false NOT NULL,
  "transaction_fingerprint" text NOT NULL,
  "duplicate_status" text DEFAULT 'new' NOT NULL,
  "is_group_service" boolean DEFAULT false NOT NULL,
  "service_session_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL,
  "normalized_alias" text NOT NULL,
  "source_text" text NOT NULL,
  "status" text DEFAULT 'approved' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_rate_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "agency_rate" numeric(14, 4),
  "internal_rate" numeric(14, 4) NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "is_group_capable" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_exceptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_batch_id" uuid,
  "payroll_transaction_id" uuid,
  "individual_id" uuid,
  "program_id" uuid,
  "imported_rate" numeric(14, 4) NOT NULL,
  "expected_rate" numeric(14, 4) NOT NULL,
  "variance_amount" numeric(14, 4) NOT NULL,
  "variance_percent" numeric(9, 6) NOT NULL,
  "direction" text NOT NULL,
  "resolution" text DEFAULT 'open' NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_session_id" uuid NOT NULL,
  "individual_id" uuid NOT NULL,
  "payroll_transaction_id" uuid,
  "allocation_hours" numeric(10, 4) NOT NULL,
  "allocated_rate" numeric(14, 4) NOT NULL,
  "allocated_amount" numeric(14, 4) NOT NULL,
  "rounding_adjustment" numeric(14, 4) DEFAULT '0' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_batch_id" uuid,
  "employee_id" uuid,
  "program_id" uuid,
  "check_number" text,
  "period_begin" date,
  "period_end" date,
  "physical_hours" numeric(10, 4) NOT NULL,
  "group_size" integer DEFAULT 1 NOT NULL,
  "combined_rate" numeric(14, 4),
  "combined_amount" numeric(14, 4),
  "base_individual_rate" numeric(14, 4),
  "group_detection_status" text DEFAULT 'single' NOT NULL,
  "detection_rule" text,
  "detection_signature" text,
  "confidence" numeric(9, 6),
  "validation_result" jsonb,
  "warning_reason" text,
  "source_row_refs" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "display_name" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" text DEFAULT 'viewer' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_adjustments" ADD CONSTRAINT "account_adjustments_account_period_id_account_periods_id_fk" FOREIGN KEY ("account_period_id") REFERENCES "public"."account_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_adjustments" ADD CONSTRAINT "account_adjustments_adjusted_by_user_id_users_id_fk" FOREIGN KEY ("adjusted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_configurations" ADD CONSTRAINT "account_configurations_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_periods" ADD CONSTRAINT "account_periods_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_periods" ADD CONSTRAINT "account_periods_budget_period_id_budget_periods_id_fk" FOREIGN KEY ("budget_period_id") REFERENCES "public"."budget_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD CONSTRAINT "budget_authorizations_budget_period_id_budget_periods_id_fk" FOREIGN KEY ("budget_period_id") REFERENCES "public"."budget_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD CONSTRAINT "budget_authorizations_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD CONSTRAINT "budget_authorizations_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD CONSTRAINT "employee_aliases_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD CONSTRAINT "employee_aliases_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_imported_file_id_imported_files_id_fk" FOREIGN KEY ("imported_file_id") REFERENCES "public"."imported_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_committed_by_user_id_users_id_fk" FOREIGN KEY ("committed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_resolved_individual_id_individuals_id_fk" FOREIGN KEY ("resolved_individual_id") REFERENCES "public"."individuals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_resolved_employee_id_employees_id_fk" FOREIGN KEY ("resolved_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_resolved_program_id_programs_id_fk" FOREIGN KEY ("resolved_program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_warnings" ADD CONSTRAINT "import_warnings_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_files" ADD CONSTRAINT "imported_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "individual_aliases" ADD CONSTRAINT "individual_aliases_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "individual_aliases" ADD CONSTRAINT "individual_aliases_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_source_file_id_imported_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."imported_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_aliases" ADD CONSTRAINT "program_aliases_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_rate_schedules" ADD CONSTRAINT "program_rate_schedules_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_exceptions" ADD CONSTRAINT "rate_exceptions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_exceptions" ADD CONSTRAINT "rate_exceptions_payroll_transaction_id_payroll_transactions_id_fk" FOREIGN KEY ("payroll_transaction_id") REFERENCES "public"."payroll_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_exceptions" ADD CONSTRAINT "rate_exceptions_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_exceptions" ADD CONSTRAINT "rate_exceptions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_allocations" ADD CONSTRAINT "service_allocations_service_session_id_service_sessions_id_fk" FOREIGN KEY ("service_session_id") REFERENCES "public"."service_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_allocations" ADD CONSTRAINT "service_allocations_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_allocations" ADD CONSTRAINT "service_allocations_payroll_transaction_id_payroll_transactions_id_fk" FOREIGN KEY ("payroll_transaction_id") REFERENCES "public"."payroll_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_sessions" ADD CONSTRAINT "service_sessions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_sessions" ADD CONSTRAINT "service_sessions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_sessions" ADD CONSTRAINT "service_sessions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_adjustments_period_idx" ON "account_adjustments" USING btree ("account_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_configurations_individual_key" ON "account_configurations" USING btree ("individual_id");--> statement-breakpoint
CREATE INDEX "account_periods_individual_idx" ON "account_periods" USING btree ("individual_id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_auth_period_program_key" ON "budget_authorizations" USING btree ("budget_period_id","program_id");--> statement-breakpoint
CREATE INDEX "budget_auth_individual_idx" ON "budget_authorizations" USING btree ("individual_id");--> statement-breakpoint
CREATE INDEX "budget_periods_individual_idx" ON "budget_periods" USING btree ("individual_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_aliases_alias_key" ON "employee_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_normalized_name_key" ON "employees" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "import_batches_file_idx" ON "import_batches" USING btree ("imported_file_id");--> statement-breakpoint
CREATE INDEX "import_rows_batch_idx" ON "import_rows" USING btree ("import_batch_id","status");--> statement-breakpoint
CREATE INDEX "import_rows_fingerprint_idx" ON "import_rows" USING btree ("transaction_fingerprint");--> statement-breakpoint
CREATE INDEX "import_warnings_batch_idx" ON "import_warnings" USING btree ("import_batch_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_files_checksum_key" ON "imported_files" USING btree ("checksum_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "individual_aliases_alias_key" ON "individual_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "individuals_normalized_name_key" ON "individuals" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "payroll_tx_fingerprint_idx" ON "payroll_transactions" USING btree ("transaction_fingerprint");--> statement-breakpoint
CREATE INDEX "payroll_tx_individual_idx" ON "payroll_transactions" USING btree ("individual_id","period_begin");--> statement-breakpoint
CREATE INDEX "payroll_tx_employee_idx" ON "payroll_transactions" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "payroll_tx_check_idx" ON "payroll_transactions" USING btree ("check_number");--> statement-breakpoint
CREATE UNIQUE INDEX "program_aliases_alias_key" ON "program_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "program_rate_schedules_program_idx" ON "program_rate_schedules" USING btree ("program_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "programs_code_key" ON "programs" USING btree ("code");--> statement-breakpoint
CREATE INDEX "rate_exceptions_batch_idx" ON "rate_exceptions" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "service_allocations_individual_idx" ON "service_allocations" USING btree ("individual_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_allocations_session_individual_key" ON "service_allocations" USING btree ("service_session_id","individual_id");--> statement-breakpoint
CREATE INDEX "service_sessions_signature_idx" ON "service_sessions" USING btree ("detection_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");

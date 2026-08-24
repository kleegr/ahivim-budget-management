-- Phase 15: make settlement derivation freshness explicit and enforceable.
--
-- Source writes advance a version in the same transaction that changes the
-- source. A full settlement refresh catches the refreshed version up and
-- records the UTC application date used by rolling budget calculations. The
-- advisory lock serializes source writes, refreshes, and settlement actions so
-- an action can never race a source change and use an obsolete balance.

CREATE TABLE "settlement_ledger_state" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "source_version" bigint NOT NULL DEFAULT 1,
  "refreshed_version" bigint NOT NULL DEFAULT 0,
  "dirty_since" timestamptz,
  "last_refreshed_at" timestamptz,
  "refreshed_for_date" date,
  "last_refresh_error" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "settlement_ledger_state_singleton_check" CHECK ("singleton"),
  CONSTRAINT "settlement_ledger_state_versions_check"
    CHECK ("source_version" >= 0 AND "refreshed_version" >= 0 AND "refreshed_version" <= "source_version")
);--> statement-breakpoint

INSERT INTO "settlement_ledger_state"
  ("singleton", "source_version", "refreshed_version", "dirty_since")
VALUES (true, 1, 0, now());--> statement-breakpoint

CREATE OR REPLACE FUNCTION "mark_settlement_ledger_dirty"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ahivim:settlement-ledger-source'));
  UPDATE "settlement_ledger_state"
     SET "source_version" = "source_version" + 1,
         "dirty_since" = COALESCE("dirty_since", now()),
         "updated_at" = now()
   WHERE "singleton" = true;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "payroll_transactions_settlement_dirty_insert_delete"
  BEFORE INSERT OR DELETE ON "payroll_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TRIGGER "payroll_transactions_settlement_dirty_update"
  BEFORE UPDATE OF
    "employee_id", "individual_id", "program_id", "check_number", "check_date",
    "period_begin", "period_end", "payment_recipient", "imported_amount",
    "imported_hours", "total_net_pay", "calculated_internal_amount",
    "spreadsheet_internal_amount", "internal_rate_applied"
  ON "payroll_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TRIGGER "employee_deals_settlement_dirty"
  BEFORE INSERT OR UPDATE OR DELETE ON "employee_deals"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TRIGGER "calculation_strategies_settlement_dirty"
  BEFORE INSERT OR UPDATE OR DELETE ON "calculation_strategies"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TRIGGER "calculation_strategy_lines_settlement_dirty"
  BEFORE INSERT OR UPDATE OR DELETE ON "calculation_strategy_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TRIGGER "program_rate_schedules_settlement_dirty"
  BEFORE INSERT OR UPDATE OR DELETE ON "program_rate_schedules"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TRIGGER "programs_settlement_dirty"
  BEFORE UPDATE OF "code", "is_active" ON "programs"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TRIGGER "individual_status_settlement_dirty"
  BEFORE UPDATE OF "status" ON "individuals"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();
--> statement-breakpoint

CREATE TRIGGER "employee_status_settlement_dirty"
  BEFORE UPDATE OF "status" ON "employees"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();

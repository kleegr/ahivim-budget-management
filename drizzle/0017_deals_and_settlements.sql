-- Phase 13: effective-dated employee deals and an auditable settlement ledger.
--
-- Deals determine the terms in force on a transaction's check date. When a
-- check is paid directly to an employee, direct_percent applies to the whole
-- check NET (taxes may be displayed but are not part of the formula). When the
-- payment is routed to the agency, agency_cut_percent applies to the
-- base/internal amount; the funder-to-base spread is outside the deal.
--
-- Settlement obligations record what is owed; signed events record partial
-- payments, set-asides, credits, adjustments and reversals without overwriting
-- history. Every change in this migration is additive and preserves existing
-- data.

CREATE TABLE "employee_deals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "direct_rule" text NOT NULL DEFAULT 'keep_all',
  "direct_percent" numeric(9, 6) NOT NULL DEFAULT 0,
  "agency_cut_percent" numeric(9, 6) NOT NULL DEFAULT 0,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "revision" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "archived_by_user_id" uuid REFERENCES "users"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employee_deals_direct_rule_check"
    CHECK ("direct_rule" IN ('keep_all', 'giveback_percent', 'giveback_all')),
  CONSTRAINT "employee_deals_direct_percent_check"
    CHECK ("direct_percent" >= 0 AND "direct_percent" <= 1),
  CONSTRAINT "employee_deals_agency_cut_percent_check"
    CHECK ("agency_cut_percent" >= 0 AND "agency_cut_percent" <= 1),
  CONSTRAINT "employee_deals_effective_range_check"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "employee_deals_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "employee_deals_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "employee_deals_archive_state_check"
    CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "employee_deals_employee_effective_key"
  ON "employee_deals" ("employee_id", "effective_from");--> statement-breakpoint
CREATE INDEX "employee_deals_effective_idx"
  ON "employee_deals" ("employee_id", "status", "effective_from", "effective_to");--> statement-breakpoint

CREATE TABLE "employee_deal_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_deal_id" uuid NOT NULL REFERENCES "employee_deals"("id"),
  "revision" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "reason" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employee_deal_revisions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "employee_deal_revisions_snapshot_check"
    CHECK (jsonb_typeof("snapshot") = 'object'),
  CONSTRAINT "employee_deal_revisions_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "employee_deal_revisions_deal_revision_key"
    UNIQUE ("employee_deal_id", "revision")
);--> statement-breakpoint

CREATE TABLE "settlement_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "action" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "settlement_batches_action_check" CHECK (length(btrim("action")) > 0),
  CONSTRAINT "settlement_batches_metadata_check" CHECK (jsonb_typeof("metadata") = 'object')
);--> statement-breakpoint

CREATE UNIQUE INDEX "settlement_batches_idempotency_key"
  ON "settlement_batches" ("idempotency_key");--> statement-breakpoint

CREATE TABLE "settlement_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_key" text NOT NULL,
  "kind" text NOT NULL,
  "direction" text NOT NULL,
  "employee_id" uuid REFERENCES "employees"("id"),
  "individual_id" uuid REFERENCES "individuals"("id"),
  "employee_deal_id" uuid REFERENCES "employee_deals"("id"),
  "calculation_strategy_id" uuid REFERENCES "calculation_strategies"("id"),
  "original_amount" numeric(14, 4) NOT NULL,
  "check_number" text,
  "check_date" date,
  "period_begin" date,
  "period_end" date,
  "calculation_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "voided_by_user_id" uuid REFERENCES "users"("id"),
  "voided_at" timestamptz,
  "void_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "settlement_obligations_source_key_check"
    CHECK (length(btrim("source_key")) > 0),
  CONSTRAINT "settlement_obligations_kind_check" CHECK (length(btrim("kind")) > 0),
  CONSTRAINT "settlement_obligations_direction_check"
    CHECK ("direction" IN ('receivable', 'payable', 'reserve')),
  CONSTRAINT "settlement_obligations_person_check"
    CHECK (("employee_id" IS NOT NULL) <> ("individual_id" IS NOT NULL)),
  CONSTRAINT "settlement_obligations_amount_check" CHECK ("original_amount" > 0),
  CONSTRAINT "settlement_obligations_period_check"
    CHECK ("period_end" IS NULL OR "period_begin" IS NULL OR "period_end" >= "period_begin"),
  CONSTRAINT "settlement_obligations_metadata_check"
    CHECK (jsonb_typeof("calculation_metadata") = 'object'),
  CONSTRAINT "settlement_obligations_status_check" CHECK ("status" IN ('active', 'void')),
  CONSTRAINT "settlement_obligations_void_state_check"
    CHECK (("status" = 'void') = ("voided_at" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "settlement_obligations_source_key_key"
  ON "settlement_obligations" ("source_key");--> statement-breakpoint
CREATE INDEX "settlement_obligations_employee_idx"
  ON "settlement_obligations" ("employee_id", "status", "check_date");--> statement-breakpoint
CREATE INDEX "settlement_obligations_individual_idx"
  ON "settlement_obligations" ("individual_id", "status", "check_date");--> statement-breakpoint
CREATE INDEX "settlement_obligations_deal_idx"
  ON "settlement_obligations" ("employee_deal_id");--> statement-breakpoint
CREATE INDEX "settlement_obligations_strategy_idx"
  ON "settlement_obligations" ("calculation_strategy_id");--> statement-breakpoint

CREATE TABLE "settlement_obligation_transactions" (
  "settlement_obligation_id" uuid NOT NULL REFERENCES "settlement_obligations"("id"),
  "payroll_transaction_id" uuid NOT NULL REFERENCES "payroll_transactions"("id"),
  "allocated_amount" numeric(14, 4),
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "settlement_obligation_transactions_pk"
    PRIMARY KEY ("settlement_obligation_id", "payroll_transaction_id"),
  CONSTRAINT "settlement_obligation_transactions_amount_check"
    CHECK ("allocated_amount" IS NULL OR "allocated_amount" > 0)
);--> statement-breakpoint

CREATE INDEX "settlement_obligation_transactions_transaction_idx"
  ON "settlement_obligation_transactions" ("payroll_transaction_id");--> statement-breakpoint

CREATE TABLE "settlement_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "settlement_obligation_id" uuid REFERENCES "settlement_obligations"("id"),
  "settlement_batch_id" uuid REFERENCES "settlement_batches"("id"),
  "employee_id" uuid REFERENCES "employees"("id"),
  "individual_id" uuid REFERENCES "individuals"("id"),
  "event_type" text NOT NULL,
  "amount" numeric(14, 4) NOT NULL,
  "occurred_on" date NOT NULL,
  "reference" text,
  "note" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "reversal_of_event_id" uuid REFERENCES "settlement_events"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "settlement_events_type_check"
    CHECK ("event_type" IN ('payment', 'set_aside', 'credit', 'adjustment', 'reversal')),
  CONSTRAINT "settlement_events_amount_check" CHECK ("amount" <> 0),
  CONSTRAINT "settlement_events_person_check"
    CHECK (("employee_id" IS NOT NULL) <> ("individual_id" IS NOT NULL)),
  CONSTRAINT "settlement_events_unapplied_check"
    CHECK (
      "settlement_obligation_id" IS NOT NULL
      OR "event_type" IN ('credit', 'reversal')
    ),
  CONSTRAINT "settlement_events_reversal_check"
    CHECK (
      ("event_type" = 'reversal' AND "reversal_of_event_id" IS NOT NULL)
      OR ("event_type" <> 'reversal' AND "reversal_of_event_id" IS NULL)
    )
);--> statement-breakpoint

CREATE INDEX "settlement_events_obligation_idx"
  ON "settlement_events" ("settlement_obligation_id", "occurred_on");--> statement-breakpoint
CREATE INDEX "settlement_events_employee_idx"
  ON "settlement_events" ("employee_id", "occurred_on");--> statement-breakpoint
CREATE INDEX "settlement_events_individual_idx"
  ON "settlement_events" ("individual_id", "occurred_on");--> statement-breakpoint
CREATE INDEX "settlement_events_batch_idx"
  ON "settlement_events" ("settlement_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_events_one_reversal_key"
  ON "settlement_events" ("reversal_of_event_id")
  WHERE "reversal_of_event_id" IS NOT NULL;--> statement-breakpoint

-- Revisions and settlement events are append-only audit history. Corrections
-- are represented by a new revision or an explicit reversal event. A person
-- merge may only repoint the event's person foreign key; every financial and
-- audit field remains immutable.
CREATE OR REPLACE FUNCTION "prevent_settlement_history_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; append a revision or reversal instead', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "employee_deal_revisions_immutable"
  BEFORE UPDATE OR DELETE ON "employee_deal_revisions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_settlement_history_mutation"();--> statement-breakpoint

CREATE TRIGGER "settlement_batches_immutable"
  BEFORE UPDATE OR DELETE ON "settlement_batches"
  FOR EACH ROW EXECUTE FUNCTION "prevent_settlement_history_mutation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "prevent_settlement_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (
      (
        (OLD."employee_id" IS NOT NULL AND NEW."employee_id" IS NOT NULL
          AND OLD."individual_id" IS NULL AND NEW."individual_id" IS NULL)
        OR
        (OLD."individual_id" IS NOT NULL AND NEW."individual_id" IS NOT NULL
          AND OLD."employee_id" IS NULL AND NEW."employee_id" IS NULL)
      )
      AND (to_jsonb(NEW) - ARRAY['employee_id', 'individual_id'])
        = (to_jsonb(OLD) - ARRAY['employee_id', 'individual_id'])
    ) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% is immutable; append a reversal instead', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "settlement_events_immutable"
  BEFORE UPDATE OR DELETE ON "settlement_events"
  FOR EACH ROW EXECUTE FUNCTION "prevent_settlement_event_mutation"();--> statement-breakpoint

-- Every applied event carries the same person identity as its obligation. This
-- prevents a partial person merge or a hand-written insert from splitting the
-- audit trail across two people.
CREATE OR REPLACE FUNCTION "enforce_settlement_event_person"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obligation_employee_id uuid;
  obligation_individual_id uuid;
BEGIN
  IF NEW."settlement_obligation_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "employee_id", "individual_id"
    INTO obligation_employee_id, obligation_individual_id
    FROM "settlement_obligations"
   WHERE "id" = NEW."settlement_obligation_id"
   FOR SHARE;

  IF NOT FOUND OR NEW."employee_id" IS DISTINCT FROM obligation_employee_id
    OR NEW."individual_id" IS DISTINCT FROM obligation_individual_id THEN
    RAISE EXCEPTION 'settlement event person must match its obligation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "settlement_events_person_matches_obligation"
  BEFORE INSERT OR UPDATE ON "settlement_events"
  FOR EACH ROW EXECUTE FUNCTION "enforce_settlement_event_person"();
--> statement-breakpoint

-- Unactioned obligations may be refreshed in place. Once an obligation has
-- ledger activity, its snapshot is immutable and recalculation is represented
-- by a correction obligation. Person merges may still repoint the identity.
CREATE OR REPLACE FUNCTION "protect_settlement_obligation_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement obligations are immutable; void or correct the obligation instead';
  END IF;

  IF (
    (
      (OLD."employee_id" IS NOT NULL AND NEW."employee_id" IS NOT NULL
        AND OLD."individual_id" IS NULL AND NEW."individual_id" IS NULL)
      OR
      (OLD."individual_id" IS NOT NULL AND NEW."individual_id" IS NOT NULL
        AND OLD."employee_id" IS NULL AND NEW."employee_id" IS NULL)
    )
    AND (
      OLD."employee_id" IS DISTINCT FROM NEW."employee_id"
      OR OLD."individual_id" IS DISTINCT FROM NEW."individual_id"
    )
    AND (to_jsonb(NEW) - ARRAY['employee_id', 'individual_id', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['employee_id', 'individual_id', 'updated_at'])
  ) THEN
    RETURN NEW;
  END IF;

  IF OLD."calculation_metadata" ? 'adjustmentForObligationId'
    OR EXISTS (
      SELECT 1
        FROM "settlement_events"
       WHERE "settlement_obligation_id" = OLD."id"
    ) THEN
    RAISE EXCEPTION 'actioned settlement obligations are immutable; append a correction instead';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "settlement_obligations_snapshot_guard"
  BEFORE UPDATE OR DELETE ON "settlement_obligations"
  FOR EACH ROW EXECUTE FUNCTION "protect_settlement_obligation_snapshot"();
--> statement-breakpoint

-- Person repoints are allowed only when the obligation and all of its events
-- finish the transaction on the same person. Deferral lets the merge update
-- both tables atomically while rejecting an obligation-only repoint at commit.
CREATE OR REPLACE FUNCTION "validate_settlement_obligation_event_person"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obligation_id uuid;
BEGIN
  obligation_id := CASE
    WHEN TG_TABLE_NAME = 'settlement_events' THEN NEW."settlement_obligation_id"
    ELSE NEW."id"
  END;

  IF obligation_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM "settlement_events" e
      JOIN "settlement_obligations" o ON o."id" = e."settlement_obligation_id"
     WHERE o."id" = obligation_id
       AND (
         e."employee_id" IS DISTINCT FROM o."employee_id"
         OR e."individual_id" IS DISTINCT FROM o."individual_id"
       )
  ) THEN
    RAISE EXCEPTION 'settlement obligation and event person must match at commit';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "settlement_obligations_event_person_consistent"
  AFTER INSERT OR UPDATE ON "settlement_obligations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_settlement_obligation_event_person"();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "settlement_events_obligation_person_consistent"
  AFTER INSERT OR UPDATE ON "settlement_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_settlement_obligation_event_person"();
--> statement-breakpoint

-- Transaction provenance follows an obligation while it is still a draft.
-- After the first event, those links form part of the immutable audit record.
CREATE OR REPLACE FUNCTION "protect_actioned_settlement_provenance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  protected_obligation_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    protected_obligation_ids := ARRAY[NEW."settlement_obligation_id"];
  ELSIF TG_OP = 'DELETE' THEN
    protected_obligation_ids := ARRAY[OLD."settlement_obligation_id"];
  ELSE
    protected_obligation_ids := ARRAY[
      OLD."settlement_obligation_id",
      NEW."settlement_obligation_id"
    ];
  END IF;

  -- Use the obligation row as the serialization point shared by refresh and
  -- payment operations. Ordered locking also keeps a rare cross-obligation
  -- provenance correction from deadlocking with another correction.
  PERFORM "id"
    FROM "settlement_obligations"
   WHERE "id" = ANY(protected_obligation_ids)
   ORDER BY "id"
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM "settlement_events"
     WHERE "settlement_obligation_id" = ANY(protected_obligation_ids)
  ) THEN
    RAISE EXCEPTION 'actioned settlement transaction provenance is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "settlement_obligation_transactions_actioned_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "settlement_obligation_transactions"
  FOR EACH ROW EXECUTE FUNCTION "protect_actioned_settlement_provenance"();

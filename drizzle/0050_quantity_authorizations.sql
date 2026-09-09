-- Explicit non-money quantities. Consumption is a verified manual quantity,
-- never inferred from a payroll dollar, service hour, or planned visit.
CREATE TABLE quantity_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), individual_id uuid NOT NULL REFERENCES individuals(id),
 program_id uuid NOT NULL REFERENCES programs(id), unit_label text NOT NULL CHECK (length(btrim(unit_label)) BETWEEN 1 AND 40),
 authorized_quantity numeric(16,4) NOT NULL CHECK (authorized_quantity >= 0),
 start_date date NOT NULL, end_date date NOT NULL CHECK (end_date >= start_date),
 consumption_source text NOT NULL DEFAULT 'verified_manual_quantity' CHECK (consumption_source = 'verified_manual_quantity'),
 revision integer NOT NULL DEFAULT 1, created_by_user_id uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 request_id uuid NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE quantity_authorization_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), authorization_id uuid NOT NULL REFERENCES quantity_authorizations(id),
 revision integer NOT NULL, snapshot jsonb NOT NULL, reason text NOT NULL,
 created_by_user_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (authorization_id, revision)
);
--> statement-breakpoint
CREATE TABLE quantity_usage_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), authorization_id uuid NOT NULL REFERENCES quantity_authorizations(id),
 service_date date NOT NULL, quantity numeric(16,4) NOT NULL,
 evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) >= 3),
 reverses_event_id uuid UNIQUE REFERENCES quantity_usage_events(id), reason text NOT NULL,
 created_by_user_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 request_id uuid NOT NULL UNIQUE,
 CHECK ((reverses_event_id IS NULL AND quantity > 0) OR (reverses_event_id IS NOT NULL AND quantity < 0))
);
--> statement-breakpoint
CREATE INDEX quantity_authorizations_person_program ON quantity_authorizations (individual_id, program_id, start_date);
--> statement-breakpoint
CREATE FUNCTION preserve_quantity_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Quantity history is append-only; use an audited reversal or revision.'; END $$;
--> statement-breakpoint
CREATE TRIGGER quantity_usage_append_only BEFORE UPDATE OR DELETE ON quantity_usage_events FOR EACH ROW EXECUTE FUNCTION preserve_quantity_history();
--> statement-breakpoint
CREATE TRIGGER quantity_revisions_append_only BEFORE UPDATE OR DELETE ON quantity_authorization_revisions FOR EACH ROW EXECUTE FUNCTION preserve_quantity_history();

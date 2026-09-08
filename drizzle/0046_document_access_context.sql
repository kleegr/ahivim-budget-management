-- Existing documents deliberately remain unclassified and Owner-only.
ALTER TABLE documents ADD COLUMN access_context jsonb;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_access_context_check CHECK (
  access_context IS NULL OR (
    jsonb_typeof(access_context) = 'object'
    AND access_context->>'kind' IN ('owner', 'private', 'classes', 'planning', 'payroll', 'settlements')
  )
);
--> statement-breakpoint
-- An Owner approves one immutable, sanitized output for one explicit recipient.
-- No source/editor/history permission is inherited from publication.
CREATE TABLE document_publications (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_id uuid NOT NULL,
  title text NOT NULL CONSTRAINT document_publications_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 180),
  individual_id uuid REFERENCES individuals(id),
  employee_id uuid REFERENCES employees(id),
  agency_id uuid REFERENCES agencies(id),
  scope_date date,
  required_capabilities text[] NOT NULL CONSTRAINT document_publications_categories_check CHECK (cardinality(required_capabilities) > 0),
  sanitized_pathname text NOT NULL UNIQUE,
  sanitized_byte_size bigint NOT NULL CHECK (sanitized_byte_size > 0 AND sanitized_byte_size <= 104857600),
  sanitized_sha256 text NOT NULL CHECK (sanitized_sha256 ~ '^[0-9a-f]{64}$'),
  sanitizer_version integer NOT NULL CHECK (sanitizer_version = 1),
  approved_by_user_id uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(document_id, user_id),
  FOREIGN KEY(document_id, version_id) REFERENCES document_versions(document_id, id),
  CONSTRAINT document_publications_subject_check CHECK (num_nonnulls(individual_id, employee_id) = 1),
  CONSTRAINT document_publications_date_check CHECK ((agency_id IS NULL AND scope_date IS NULL) OR (agency_id IS NOT NULL AND scope_date IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX document_publications_user_idx ON document_publications(user_id, document_id);

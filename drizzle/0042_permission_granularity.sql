-- Separate check-gross visibility from check-net visibility, and Planning
-- read access from Planning mutation access. Existing accounts retain their
-- exact effective behavior when the new columns are introduced.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_check_gross" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "can_manage_planning" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "can_view_documents" boolean NOT NULL DEFAULT false;--> statement-breakpoint

UPDATE "users"
   SET "can_see_check_gross" = "can_see_check_net",
       "can_manage_planning" = "can_plan",
       "can_view_documents" = "can_edit_documents";--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_planning_manage_requires_view_check"
  CHECK (NOT "can_manage_planning" OR "can_plan");--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_document_edit_requires_view_check"
  CHECK (NOT "can_edit_documents" OR "can_view_documents");

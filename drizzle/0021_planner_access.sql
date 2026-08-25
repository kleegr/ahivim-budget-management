-- A planner may manage schedules and hour-based budgets without receiving the
-- manager role or any financial visibility. Existing trusted staff retain the
-- planning access they already had through their role.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_plan" boolean NOT NULL DEFAULT false;--> statement-breakpoint

UPDATE "users"
   SET "can_plan" = true
 WHERE "role" IN ('manager', 'admin');

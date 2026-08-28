-- Reading financial balances and changing the settlement ledger are separate
-- responsibilities. Preserve every existing operator during the upgrade, then
-- let administrators remove write authority without hiding the reports.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_manage_settlements" boolean NOT NULL DEFAULT false;

UPDATE "users"
   SET "can_manage_settlements" = "can_see_settlements";

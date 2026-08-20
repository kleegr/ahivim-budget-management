-- Phase 11: an "hours only" access flag.
-- Some users may see hours (how much was authorized and billed) but no dollar
-- amounts at all. Additive and data-preserving: every existing user defaults to
-- seeing money, so nothing changes until an admin turns this off for someone.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_money" boolean NOT NULL DEFAULT true;

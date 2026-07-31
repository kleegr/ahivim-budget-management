-- Phase 8: per-strategy program rate overrides, editable from Calculations.
-- Each strategy program line may carry its own hourly rate; when null the
-- effective-dated default from program_rate_schedules is used. Changes are
-- captured in the existing calculation_strategy_revisions snapshots (which
-- include this column via to_jsonb) and audited by updateStrategy — so history,
-- audit and a clear default-vs-override distinction all come for free.
ALTER TABLE "calculation_strategy_lines"
  ADD COLUMN IF NOT EXISTS "rate_override" numeric(14, 4);

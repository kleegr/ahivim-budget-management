-- Phase 8b: effective-dated per-strategy rate overrides.
-- A calculation_strategy_lines row may already carry a rate_override (0010). This
-- adds an OPTIONAL date from which that override takes effect. When null (the
-- default, and the state of every existing row) the override behaves exactly as
-- before — it always applies. When set, the override applies only to strategies
-- whose renewal_date is on or after it; otherwise the effective-dated schedule
-- default is used. Additive and data-preserving: no existing row changes value.
ALTER TABLE "calculation_strategy_lines"
  ADD COLUMN IF NOT EXISTS "rate_override_effective_from" date;

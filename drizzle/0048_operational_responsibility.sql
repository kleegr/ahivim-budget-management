-- Operational choices are deliberately independent of the inferred agency
-- roster/access flag. No existing business values or access grants are changed.
-- NULL preserves an explicit, dated home-agency decision as the read fallback;
-- 'undecided' records an intentional neutral choice, including per-program.
ALTER TABLE individuals
  ADD COLUMN budget_responsibility text,
  ADD COLUMN budget_responsibility_by_program jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT individuals_budget_responsibility_check CHECK
    (budget_responsibility IS NULL OR budget_responsibility IN ('managed','unmanaged','undecided')),
  ADD CONSTRAINT individuals_program_responsibility_check CHECK
    (jsonb_typeof(budget_responsibility_by_program) = 'object');

ALTER TABLE employees
  ADD COLUMN scheduling_responsibility text NOT NULL DEFAULT 'undecided',
  ADD COLUMN money_responsibility text NOT NULL DEFAULT 'undecided',
  ADD CONSTRAINT employees_scheduling_responsibility_check CHECK
    (scheduling_responsibility IN ('managed','unmanaged','undecided')),
  ADD CONSTRAINT employees_money_responsibility_check CHECK
    (money_responsibility IN ('managed','unmanaged','undecided'));

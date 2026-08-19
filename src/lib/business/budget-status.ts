/**
 * One plain-language vocabulary for "where is this budget up to", shared by the
 * Individuals board, the individual profile and anywhere else that shows budget
 * health. Amount-based (used vs. authorized) — deliberately simpler than the
 * pace vocabulary, so a first-time reader understands it at a glance.
 */

export type BudgetLineStatus = "over" | "almost" | "on_track" | "unused" | "no_plan";

export const BUDGET_STATUS_PRESENT: Record<BudgetLineStatus, { label: string; color: string; tint: string }> = {
  over: { label: "Over budget", color: "var(--color-pace-over)", tint: "var(--color-danger-soft)" },
  almost: { label: "Almost used up", color: "var(--color-pace-near)", tint: "var(--color-warn-soft)" },
  on_track: { label: "On track", color: "var(--color-pace-on)", tint: "var(--color-success-soft)" },
  unused: { label: "Not used yet", color: "var(--color-pace-idle)", tint: "var(--color-surface-strong)" },
  no_plan: { label: "Billed, not in plan", color: "var(--color-info)", tint: "var(--color-info-soft)" },
};

/** Most-severe first, for picking a person's headline status across programs. */
export const BUDGET_STATUS_RANK: Record<BudgetLineStatus, number> = {
  over: 5,
  almost: 4,
  on_track: 3,
  unused: 2,
  no_plan: 1,
};

/** Classify a single budget line (or a whole person's totals) from the hours. */
export function budgetStatusFromHours(authorizedHours: number, usedHours: number): BudgetLineStatus {
  if (authorizedHours <= 0) return usedHours > 0 ? "no_plan" : "unused";
  if (usedHours <= 0) return "unused";
  if (usedHours > authorizedHours) return "over";
  if (usedHours / authorizedHours >= 0.9) return "almost";
  return "on_track";
}

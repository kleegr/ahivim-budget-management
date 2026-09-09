/** Shared operational decisions. These values never authorize access or money. */
export const RESPONSIBILITIES = ['managed', 'unmanaged', 'undecided'] as const;
export type Responsibility = (typeof RESPONSIBILITIES)[number];
export const RESPONSIBILITY_LABELS: Record<Responsibility, string> = {
  managed: 'Managed by us',
  unmanaged: 'Not managed by us',
  undecided: 'Not decided yet',
};
export interface IndividualResponsibility {
  budget: Responsibility;
  programs: Record<string, Responsibility>;
  source: 'saved' | 'agency' | 'undecided';
}
export interface EmployeeResponsibility {
  scheduling: Responsibility;
  money: Responsibility;
}
export interface OperationalFlag {
  key: string;
  message: string;
  action: string;
  href: string;
  programId?: string;
}
export interface OperationalReview {
  responsibility: IndividualResponsibility;
  flags: OperationalFlag[];
}
export function isResponsibility(value: unknown): value is Responsibility {
  return typeof value === 'string' && RESPONSIBILITIES.includes(value as Responsibility);
}
export function responsibilityForProgram(value: IndividualResponsibility, programId: string): Responsibility {
  return value.programs[programId] ?? value.budget;
}
export function responsibilityStates(value: IndividualResponsibility): Responsibility[] {
  return [...new Set([value.budget, ...Object.values(value.programs)])];
}
export function matchesOperationalFilters(
  states: Responsibility[], flags: OperationalFlag[], management: string, review: string,
): boolean {
  return (management === 'all' || states.includes(management as Responsibility))
    && (review !== 'needs_review' || flags.length > 0)
    && (review !== 'clear' || flags.length === 0);
}

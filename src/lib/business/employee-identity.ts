import type { MatchOptions } from "./name-matching";
import { createPersonIdentityResolver, type PersonIdentityDirectory, type PersonIdentityMatch } from "./person-identity";

export interface EmployeeIdentityDirectory {
  employees: PersonIdentityDirectory["people"];
  aliases: PersonIdentityDirectory["aliases"];
  merges?: PersonIdentityDirectory["merges"];
}
export type EmployeeIdentityMatch = PersonIdentityMatch;

/** Retain the employee/NET contract while sharing exact audited-person resolution. */
export function createEmployeeIdentityResolver(directory: EmployeeIdentityDirectory, options: MatchOptions = {}) {
  return createPersonIdentityResolver({ people: directory.employees, aliases: directory.aliases, merges: directory.merges }, options, "employee");
}

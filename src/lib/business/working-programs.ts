import { responsibilityForProgram, type IndividualResponsibility } from "./operational-responsibility";
/** These catalog codes are stable identities; labels can be renamed freely. */
export const INDIVIDUAL_RATE_PROGRAM_CODES = ["SH_COM_HAB", "SH_RESPITE"] as const;
export function isSelfHireProgram(code: string): boolean {
  return (INDIVIDUAL_RATE_PROGRAM_CODES as readonly string[]).includes(code);
}
export function isWorkingProgram(program: { programId: string; programCode: string }, responsibility?: IndividualResponsibility): boolean {
  return isSelfHireProgram(program.programCode) || (!!responsibility && responsibilityForProgram(responsibility, program.programId) === "managed");
}

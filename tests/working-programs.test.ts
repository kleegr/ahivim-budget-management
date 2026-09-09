import { describe, expect, it } from "vitest";
import { isWorkingProgram } from "@/lib/business/working-programs";
describe("default individual working program scope", () => {
  it("uses stable catalog codes for self-hire even when a program is renamed", () => {
    expect(isWorkingProgram({ programId: "one", programCode: "SH_COM_HAB" })).toBe(true);
    expect(isWorkingProgram({ programId: "two", programCode: "SH_RESPITE" })).toBe(true);
    expect(isWorkingProgram({ programId: "three", programCode: "COM_HAB" })).toBe(false);
  });
  it("requires an explicit managed decision for other programs and respects overrides", () => {
    const program = { programId: "one", programCode: "RESPITE" };
    expect(isWorkingProgram(program, { budget: "undecided", programs: {}, source: "undecided" })).toBe(false);
    expect(isWorkingProgram(program, { budget: "managed", programs: { one: "unmanaged" }, source: "saved" })).toBe(false);
    expect(isWorkingProgram(program, { budget: "unmanaged", programs: { one: "managed" }, source: "saved" })).toBe(true);
  });
});

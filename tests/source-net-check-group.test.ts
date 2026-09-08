import { beforeAll, describe, expect, it } from "vitest";
import { normalizePersonName, type AliasRecord, type CanonicalRecord } from "@/lib/business/name-matching";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { sourceNetCheckGroup, type SourceNetEmployeeDirectory } from "@/lib/sheets/source-net-check-group";
import { numericSheetFixture } from "./support/sheet-numeric-fixture";

const name = "Synthetic Numeric Employee", aliasName = "Alternate Employee Label";
const canonical = (id: string, displayName: string): CanonicalRecord => ({ id, displayName, normalizedName: normalizePersonName(displayName) });
const employees = [canonical("target", name), canonical("other", "Distinct Employee")];
const alias = (targetId = "target", status: AliasRecord["status"] = "approved"): AliasRecord =>
  ({ targetId, status, normalizedAlias: normalizePersonName(aliasName) });
let original: ParsedAhivimRow;
beforeAll(async () => { original = parseSheetCsv((await numericSheetFixture()).csv).ahivimRows[0]!; });
function row(sourceRowNumber: number, fields: Record<string, string | null> = {}, malformed = false): ParsedAhivimRow {
  return { ...original, sourceRowNumber,
    raw: { ...original.raw, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? ""])) },
    parsed: malformed ? null : { ...original.parsed!, ...fields } };
}
const group = (rows: ParsedAhivimRow[], aliases: AliasRecord[] = [], people = employees, employeeId: string | null = "target") =>
  sourceNetCheckGroup(rows, original.parsed!, employeeId, { employees: people, aliases });

describe("Canonical employee identity for current source NET checks", () => {
  it("joins approved aliases and normalized canonical spellings across compatible partial check coordinates", () => {
    const result = group([row(4), row(5, { employee: aliasName, periodBegin: null, periodEnd: null }),
      row(6, { employee: "Employee, Synthetic Numeric", checkNumber: null })], [alias()]);
    expect(result).toEqual({ rowNumbers: new Set([4, 5, 6]), unresolved: false });
  });

  for (const [label, aliases] of [["unmatched", []], ["pending", [alias("target", "pending")]],
    ["ambiguous", [alias(), alias("other")]], ["dangling", [alias("missing")]]] as const) {
    it(`holds a compatible ${label} employee instead of excluding a possible sibling`, () => {
      expect(group([row(4), row(5, { employee: aliasName })], [...aliases]))
        .toEqual({ rowNumbers: new Set([4]), unresolved: true });
    });
  }

  it("holds ambiguous canonical people and a missing or mismatched recorded employee", () => {
    expect(group([row(4)], [], [...employees, canonical("duplicate", name)]).unresolved).toBe(true);
    expect(group([row(4)], [], employees, null).unresolved).toBe(true);
    expect(group([row(4)], [], employees, "other").unresolved).toBe(true);
  });

  it("excludes a known different employee when no approved alias contradicts that identity", () => {
    expect(group([row(4), row(5, { employee: "Distinct Employee" })]))
      .toEqual({ rowNumbers: new Set([4]), unresolved: false });
  });

  it("holds a canonical-name/approved-alias collision instead of letting canonical precedence hide a possible sibling", () => {
    expect(group([row(4), row(5, { employee: aliasName })], [alias()], [...employees, canonical("other", aliasName)]))
      .toEqual({ rowNumbers: new Set([4]), unresolved: true });
  });

  it("excludes an ambiguous name only when every known interpretation belongs to other employees", () => {
    expect(group([row(4), row(5, { employee: aliasName })], [alias("other")],
      [...employees, canonical("third", aliasName)]))
      .toEqual({ rowNumbers: new Set([4]), unresolved: false });
  });

  function mergedDirectory(): SourceNetEmployeeDirectory {
    return { employees: [{ ...employees[0]!, status: "active" },
      { ...canonical("archived", aliasName), status: "archived" }], aliases: [alias()],
    merges: [{ mergedId: "archived", survivorId: "target", mergedName: aliasName }] };
  }
  const mergedGroup = (directory: SourceNetEmployeeDirectory, employeeId = "target") =>
    sourceNetCheckGroup([row(4, { employee: aliasName })], { ...original.parsed!, employee: aliasName }, employeeId, directory);

  it("honors an exact audited merge with an archived predecessor and unique approved alias to the active survivor", () => {
    expect(mergedGroup(mergedDirectory())).toEqual({ rowNumbers: new Set([4]), unresolved: false });
  });

  for (const aliasStatus of [null, "pending"] as const) {
    it(`holds a canonical survivor's compatible folded sibling when its approval alias is ${aliasStatus ?? "missing"}`, () => {
      const directory = mergedDirectory(); directory.aliases = aliasStatus === null ? [] : [alias("target", aliasStatus)];
      expect(sourceNetCheckGroup([row(4), row(5, { employee: aliasName })], original.parsed!, "target", directory))
        .toEqual({ rowNumbers: new Set([4]), unresolved: true });
    });
  }

  for (const missing of ["audit", "approved_alias", "archived_predecessor", "active_survivor", "correct_survivor", "correct_old_name", "unique_lineage"] as const) {
    it(`holds an apparent merge without ${missing} evidence`, () => {
      const directory = mergedDirectory();
      if (missing === "audit") directory.merges = [];
      if (missing === "approved_alias") directory.aliases = [alias("target", "pending")];
      if (missing === "archived_predecessor") directory.employees = directory.employees.map(p => ({ ...p, status: "active" }));
      if (missing === "active_survivor") directory.employees = directory.employees.map(p => ({ ...p, status: "archived" }));
      if (missing === "correct_survivor") directory.merges = [{ ...directory.merges![0]!, survivorId: "other" }];
      if (missing === "correct_old_name") directory.merges = [{ ...directory.merges![0]!, mergedName: "Different Historical Employee" }];
      if (missing === "unique_lineage") directory.merges = [...directory.merges!, { ...directory.merges![0]!, survivorId: "other" }];
      expect(mergedGroup(directory)).toEqual({ rowNumbers: new Set(), unresolved: true });
    });
  }

  it("keeps legitimate archived employees canonical when no completed merge establishes a replacement", () => {
    const directory = mergedDirectory(); directory.aliases = []; directory.merges = [];
    expect(mergedGroup(directory, "archived")).toEqual({ rowNumbers: new Set([4]), unresolved: false });
  });

  it("holds malformed approved or unknown possible siblings but excludes unrelated known people/checks", () => {
    expect(group([row(4), row(5, { employee: aliasName }, true)], [alias()]).unresolved).toBe(true);
    expect(group([row(4), row(5, { employee: aliasName }, true)]).unresolved).toBe(true);
    expect(group([row(4), row(5, { employee: "Distinct Employee" }, true),
      row(6, { employee: aliasName, checkNumber: "UNRELATED-CHECK" })]))
      .toEqual({ rowNumbers: new Set([4]), unresolved: false });
  });

  it("rechecks unresolved siblings after transitive partial-date expansion regardless of row order", () => {
    expect(group([
      row(7, { employee: aliasName, checkNumber: "LINKED-CHECK", checkDate: null }),
      row(6, { checkNumber: "LINKED-CHECK", checkDate: null }),
      row(5, { checkNumber: null }), row(4),
    ])).toEqual({ rowNumbers: new Set([5, 4, 6]), unresolved: true });
  });
});

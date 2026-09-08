import { createEmployeeIdentityResolver, type EmployeeIdentityDirectory } from "@/lib/business/employee-identity";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";

export type SourceNetEmployeeDirectory = EmployeeIdentityDirectory;

const text = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function compatibleCheck(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const compatibleDate = (field: string) => !text(left[field]) || !text(right[field]) || text(left[field]) === text(right[field]);
  const a = text(left.checkNumber), b = text(right.checkNumber);
  if (a && b) return a === b && compatibleDate("checkDate");
  return ["checkDate", "periodBegin", "periodEnd"].every(compatibleDate)
    && ["checkDate", "periodBegin", "periodEnd"].some(field => text(left[field]) && text(left[field]) === text(right[field]));
}

/** Resolve fresh source spellings exactly as import does; suggestions never join a check. */
export function sourceNetCheckGroup(
  rows: readonly ParsedAhivimRow[], target: Record<string, unknown>, employeeId: string | null,
  directory: SourceNetEmployeeDirectory,
): { rowNumbers: Set<number>; unresolved: boolean } {
  const employeeIds = new Set(directory.employees.map(employee => employee.id));
  const resolveEmployee = createEmployeeIdentityResolver(directory, { maxSuggestions: 0 });
  const employee = (value: unknown) => resolveEmployee(String(value ?? "")).matchedId;
  const rowNumbers = new Set<number>();
  if (!employeeId || employee(target.employee) !== employeeId) return { rowNumbers, unresolved: true };

  const identities = [target];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of rows) {
      if (!row.parsed || rowNumbers.has(row.sourceRowNumber) || employee(row.parsed.employee) !== employeeId) continue;
      if (!identities.some(member => compatibleCheck(row.parsed!, member))) continue;
      rowNumbers.add(row.sourceRowNumber);
      identities.push(row.parsed);
      expanded = true;
    }
  }
  const unresolved = rows.some(row => {
    const name = row.parsed?.employee ?? row.raw.employee;
    const matchedId = employee(name);
    if (matchedId !== null && matchedId !== employeeId) return false;
    const possible = resolveEmployee(name).possibleIds;
    // A collision solely between known other people cannot involve this
    // employee. Missing, dangling, or overlapping identities still hold.
    if (matchedId === null && possible.size && !possible.has(employeeId)
      && [...possible].every(id => employeeIds.has(id))) return false;
    if (row.parsed) {
      // A compatible check with an unknown/ambiguous employee cannot safely be
      // excluded just because the source spelling is not approved yet.
      return matchedId === null && identities.some(member => compatibleCheck(row.parsed!, member));
    }
    // Invalid dates or other malformed fields must not hide a possible sibling.
    return identities.some(member => !text(row.raw.checkNumber) || !text(member.checkNumber)
      || text(row.raw.checkNumber) === text(member.checkNumber));
  });
  return { rowNumbers, unresolved };
}

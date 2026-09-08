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

/** Only source spellings with a real calendar date can prove non-membership. */
function usableRawDate(value: unknown): string {
  const raw = text(value);
  const parts = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  const iso = parts
    ? `${parts[3]!.length === 2 ? `20${parts[3]}` : parts[3]}-${parts[1]!.padStart(2, "0")}-${parts[2]!.padStart(2, "0")}`
    : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : "";
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
    // Unreadable dates cannot exclude a possible sibling. Usable raw dates can
    // still prove an otherwise malformed row belongs to a different check.
    return identities.some(member => {
      const a = text(row.raw.checkNumber), b = text(member.checkNumber);
      if (a && b && a !== b) return false;
      const fields = a && b ? ["checkDate"] : ["checkDate", "periodBegin", "periodEnd"];
      return fields.every(field => {
        const incoming = usableRawDate(row.raw[field as keyof typeof row.raw]);
        const recorded = usableRawDate(member[field]);
        return !incoming || !recorded || incoming === recorded;
      });
    });
  });
  return { rowNumbers, unresolved };
}

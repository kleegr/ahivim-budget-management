import type { FilterState } from "@/components/data-grid/types";
import { normalizePersonName } from "@/lib/business/name-matching";
import { completeCheckIdentity } from "@/lib/business/transaction-totals";
import type { GridTransaction } from "@/lib/data/transactions-grid";

export type TransactionSearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const many = (value: string | string[] | undefined): string[] =>
  [...new Set((Array.isArray(value) ? value : value ? [value] : []).filter(Boolean))];

function hasDateFilter(filters: FilterState | undefined, key: string): boolean {
  const filter = filters?.[key];
  if (!filter) return false;
  return filter.selected !== undefined
    || (filter.from ?? "") !== ""
    || (filter.to ?? "") !== "";
}

/**
 * A date drill-through is already a fixed reporting context. The independent
 * check-date picker must not show "All time" or combine a second date basis
 * with a service-date or service-period report.
 */
export function hasInitialTransactionDateContext(filters?: FilterState): boolean {
  return hasDateFilter(filters, "checkDate")
    || hasDateFilter(filters, "serviceDate")
    || hasDateFilter(filters, "periodBegin")
    || hasDateFilter(filters, "periodEnd");
}

/** Keep a Check-mode drill-through on the exact grouping identity it displayed. */
export function filterTransactionsByCheckIdentity(
  rows: GridTransaction[],
  checkIdentity: string | undefined,
): GridTransaction[] {
  if (checkIdentity === undefined) return rows;
  return rows.filter((row) => completeCheckIdentity(row) === checkIdentity);
}

/** Resolve stable URL ids to the display values used by the transaction grid. */
export function buildInitialFilters(
  rows: GridTransaction[],
  search: TransactionSearchParams,
): { filters: FilterState; label: string | null } {
  const filters: FilterState = {};
  const labels: string[] = [];

  const setByIdOrName = (
    key: string,
    idParam: string | undefined,
    nameParam: string | undefined,
    idOf: (row: GridTransaction) => string | null,
    nameOf: (row: GridTransaction) => string | null,
  ) => {
    if (idParam) {
      const match = rows.find((row) => idOf(row) === idParam);
      const name = match ? nameOf(match) : null;
      if (name) {
        filters[key] = { selected: [name] };
        labels.push(name);
        return;
      }
    }
    if (nameParam) {
      filters[key] = { selected: [nameParam] };
      labels.push(nameParam);
    }
  };

  const individualIds = many(search.individualId);
  if (individualIds.length > 1) {
    const names = [...new Set(rows
      .filter((row) => row.individualId && individualIds.includes(row.individualId))
      .map((row) => row.individual)
      .filter((value): value is string => Boolean(value)))];
    if (names.length > 0) {
      filters.individual = { selected: names };
      labels.push(`${names.length} people`);
    }
  } else {
    setByIdOrName("individual", individualIds[0], one(search.individual), (row) => row.individualId, (row) => row.individual);
  }
  const employeeExact = one(search.employeeExact);
  if (employeeExact !== undefined) {
    filters.employee = { selected: [employeeExact] };
    labels.push(employeeExact ? employeeExact : "employee not recorded");
  } else {
    const employeeId = one(search.employeeId);
    const employeeName = one(search.employee);
    const normalizedEmployeeName = normalizePersonName(employeeName);
    const sourceNames = [...new Set(rows
      .filter((row) => employeeId
        ? row.employeeId === employeeId
        : !row.employeeId && normalizedEmployeeName !== "" && normalizePersonName(row.employee) === normalizedEmployeeName)
      .map((row) => row.employee)
      .filter((value): value is string => value !== null))];
    if (sourceNames.length > 0) {
      filters.employee = { selected: sourceNames };
      labels.push(sourceNames[0]!);
    } else {
      setByIdOrName("employee", employeeId, employeeName, (row) => row.employeeId, (row) => row.employee);
    }
  }

  const programName = one(search.program);
  const programCode = one(search.programCode);
  if (programName) {
    filters.program = { selected: [programName] };
    labels.push(programName);
  } else if (programCode) {
    const match = rows.find((row) => row.programCode === programCode);
    if (match?.program) {
      filters.program = { selected: [match.program] };
      labels.push(match.program);
    }
  }

  const payTo = one(search.payTo);
  if (payTo) {
    filters.payTo = { selected: [payTo] };
    labels.push(`paid to ${payTo}`);
  } else {
    const payToKey = one(search.payToKey)?.trim().toLocaleLowerCase();
    if (payToKey) {
      const payeeValues = [...new Set(rows
        .filter((row) => row.payTo?.trim().toLocaleLowerCase() === payToKey)
        .map((row) => row.payTo)
        .filter((value): value is string => Boolean(value)))];
      if (payeeValues.length > 0) {
        filters.payTo = { selected: payeeValues };
        labels.push(`paid to ${payeeValues[0]!.trim()}`);
      }
    }
  }

  const checkNumberExact = one(search.checkNumberExact);
  const checkNumber = one(search.checkNumber);
  if (checkNumberExact !== undefined) {
    filters.checkNumber = { selected: [checkNumberExact] };
    labels.push(checkNumberExact ? `check ${checkNumberExact}` : "check number not recorded");
  } else if (checkNumber) {
    const sourceValues = [...new Set(rows
      .map((row) => row.checkNumber)
      .filter((value): value is string => value !== null && value.trim() === checkNumber.trim()))];
    filters.checkNumber = { selected: sourceValues.length > 0 ? sourceValues : [checkNumber] };
    labels.push(`check ${checkNumber}`);
  }

  const checkDateExact = one(search.checkDateExact);
  const checkDateFrom = one(search.checkDateFrom);
  const checkDateTo = one(search.checkDateTo);
  if (checkDateExact !== undefined) {
    filters.checkDate = { selected: [checkDateExact] };
    labels.push(checkDateExact ? `check date ${checkDateExact}` : "check date not recorded");
  } else if (checkDateFrom || checkDateTo) {
    filters.checkDate = { from: checkDateFrom ?? "", to: checkDateTo ?? "" };
    if (checkDateFrom && checkDateTo) {
      labels.push(checkDateFrom === checkDateTo
        ? `check date ${checkDateFrom}`
        : `check dates ${checkDateFrom} to ${checkDateTo}`);
    } else if (checkDateFrom) labels.push(`check dates from ${checkDateFrom}`);
    else if (checkDateTo) labels.push(`check dates through ${checkDateTo}`);
  }

  const serviceDateFrom = one(search.serviceFrom);
  const serviceDateTo = one(search.serviceTo);
  if (serviceDateFrom || serviceDateTo) {
    filters.serviceDate = { from: serviceDateFrom ?? "", to: serviceDateTo ?? "" };
    if (serviceDateFrom && serviceDateTo) {
      labels.push(serviceDateFrom === serviceDateTo
        ? `service date ${serviceDateFrom}`
        : `service dates ${serviceDateFrom} to ${serviceDateTo}`);
    } else if (serviceDateFrom) labels.push(`service dates from ${serviceDateFrom}`);
    else if (serviceDateTo) labels.push(`service dates through ${serviceDateTo}`);
  }

  const periodBeginExact = one(search.periodBeginExact);
  const periodEndExact = one(search.periodEndExact);
  const hasExactPeriodIdentity = periodBeginExact !== undefined || periodEndExact !== undefined;
  if (periodBeginExact !== undefined) {
    filters.periodBegin = { selected: [periodBeginExact] };
    labels.push(periodBeginExact ? `period begins ${periodBeginExact}` : "period begin not recorded");
  }
  if (periodEndExact !== undefined) {
    filters.periodEnd = { selected: [periodEndExact] };
    labels.push(periodEndExact ? `period ends ${periodEndExact}` : "period end not recorded");
  }

  const periodFrom = one(search.pbFrom);
  const periodTo = one(search.pbTo);
  if (!hasExactPeriodIdentity && (periodFrom || periodTo)) {
    filters.periodBegin = { from: periodFrom ?? "", to: periodTo ?? "" };
    if (periodFrom && periodTo) labels.push(`service ${periodFrom} to ${periodTo}`);
    else if (periodFrom) labels.push(`service periods from ${periodFrom}`);
    else if (periodTo) labels.push(`service periods through ${periodTo}`);
  }

  const recipient = one(search.recipient);
  if (recipient) filters.paymentRecipient = { selected: [recipient] };

  const group = one(search.group);
  if (group === "1" || group === "true") filters.groupStatus = { selected: ["Group"] };
  else if (group === "0" || group === "false") filters.groupStatus = { selected: ["Individual"] };

  return { filters, label: labels.length ? labels.join(" · ") : null };
}

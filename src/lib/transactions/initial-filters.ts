import type { FilterState } from "@/components/data-grid/types";
import type { GridTransaction } from "@/lib/data/transactions-grid";

export type TransactionSearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const many = (value: string | string[] | undefined): string[] =>
  [...new Set((Array.isArray(value) ? value : value ? [value] : []).filter(Boolean))];

/**
 * A check-date drill-through is already a fixed reporting context. The grid's
 * separate period picker must not mount as "All time" and erase this filter.
 */
export function hasInitialCheckDateFilter(filters?: FilterState): boolean {
  const filter = filters?.checkDate;
  if (!filter) return false;
  return filter.selected !== undefined
    || (filter.from ?? "") !== ""
    || (filter.to ?? "") !== "";
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
  setByIdOrName("employee", one(search.employeeId), one(search.employee), (row) => row.employeeId, (row) => row.employee);

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

  const checkNumber = one(search.checkNumber);
  if (checkNumber) {
    filters.checkNumber = { selected: [checkNumber] };
    labels.push(`check ${checkNumber}`);
  }

  const checkDateFrom = one(search.checkDateFrom);
  const checkDateTo = one(search.checkDateTo);
  if (checkDateFrom || checkDateTo) {
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
    }
  }

  const periodFrom = one(search.pbFrom);
  const periodTo = one(search.pbTo);
  if (periodFrom || periodTo) {
    filters.periodBegin = { from: periodFrom ?? "", to: periodTo ?? "" };
    if (periodFrom && periodTo) labels.push(`service ${periodFrom} to ${periodTo}`);
  }

  const recipient = one(search.recipient);
  if (recipient) filters.paymentRecipient = { selected: [recipient] };

  const group = one(search.group);
  if (group === "1" || group === "true") filters.groupStatus = { selected: ["Group"] };
  else if (group === "0" || group === "false") filters.groupStatus = { selected: ["Individual"] };

  return { filters, label: labels.length ? labels.join(" · ") : null };
}

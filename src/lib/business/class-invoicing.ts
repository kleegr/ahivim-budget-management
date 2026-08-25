import { dec, toMoney, type MoneyInput } from "@/lib/money";

export const DEFAULT_CLASS_UNIT_PRICE = "150.0000";
export const DEFAULT_MONTHLY_CLASS_DAYS = 22;
export const MAX_CLASS_INVOICE_LINES = 62;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;

export function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}

export function isSaturday(value: string): boolean {
  return isIsoCalendarDate(value)
    && new Date(`${value}T00:00:00.000Z`).getUTCDay() === 6;
}

function isoDate(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/**
 * Build the standard monthly service-date slate shown in the supplied invoice:
 * the first 22 dates in the month that are not Saturdays. Sundays remain valid.
 */
export function generateMonthlyClassDates(
  yearMonth: string,
  limit = DEFAULT_MONTHLY_CLASS_DAYS,
): string[] {
  const match = YEAR_MONTH.exec(yearMonth);
  if (!match) throw new RangeError("Month must use YYYY-MM.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) {
    throw new RangeError("Month must use YYYY-MM.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLASS_INVOICE_LINES) {
    throw new RangeError(`Choose between 1 and ${MAX_CLASS_INVOICE_LINES} class dates.`);
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return generateClassDatesBetween(
    isoDate(year, month - 1, 1),
    isoDate(year, month - 1, daysInMonth),
    limit,
  );
}

/** Build up to `limit` service dates inside an allowed period, skipping Saturdays. */
export function generateClassDatesBetween(
  startDate: string,
  endDate: string,
  limit = DEFAULT_MONTHLY_CLASS_DAYS,
): string[] {
  if (!isIsoCalendarDate(startDate) || !isIsoCalendarDate(endDate) || endDate < startDate) {
    throw new RangeError("Class date range must use valid YYYY-MM-DD dates.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLASS_INVOICE_LINES) {
    throw new RangeError(`Choose between 1 and ${MAX_CLASS_INVOICE_LINES} class dates.`);
  }

  const dates: string[] = [];
  let cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  while (cursor.getTime() <= end && dates.length < limit) {
    const value = cursor.toISOString().slice(0, 10);
    if (cursor.getUTCDay() !== 6) dates.push(value);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

/** First valid non-Saturday on or after an ISO date. */
export function onOrAfterNonSaturday(value: string): string {
  if (!isIsoCalendarDate(value)) throw new RangeError("Date must use YYYY-MM-DD.");
  let parsed = new Date(`${value}T00:00:00.000Z`);
  while (parsed.getUTCDay() === 6) {
    parsed = new Date(parsed.getTime() + 86_400_000);
  }
  return parsed.toISOString().slice(0, 10);
}

export interface ClassActivityPricing {
  id: string;
  name: string;
  defaultUnitPrice: string;
}

export interface ClassInvoiceLineInput {
  activityId?: string | null;
  serviceDate: string;
  description?: string | null;
  quantity?: MoneyInput;
  unitPrice?: MoneyInput;
  discountAmount?: MoneyInput;
  sortOrder?: number | null;
  notes?: string | null;
}

export interface PreparedClassInvoiceLine {
  activityId: string | null;
  serviceDate: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  lineTotal: string;
  sortOrder: number;
  notes: string | null;
}

export type PrepareClassLinesResult =
  | { ok: true; lines: PreparedClassInvoiceLine[]; subtotal: string; discountTotal: string; totalAmount: string }
  | { ok: false; message: string };

/** Exact decimal validation and pricing for an editable draft. */
export function prepareClassInvoiceLines(
  input: readonly ClassInvoiceLineInput[],
  activities: ReadonlyMap<string, ClassActivityPricing>,
  servicePeriodStart: string,
  servicePeriodEnd: string,
): PrepareClassLinesResult {
  if (!isIsoCalendarDate(servicePeriodStart) || !isIsoCalendarDate(servicePeriodEnd)) {
    return { ok: false, message: "Give a valid class service period." };
  }
  if (servicePeriodEnd < servicePeriodStart) {
    return { ok: false, message: "The class service period ends before it starts." };
  }
  if (input.length > MAX_CLASS_INVOICE_LINES) {
    return { ok: false, message: `An invoice may contain at most ${MAX_CLASS_INVOICE_LINES} lines.` };
  }

  const lines: PreparedClassInvoiceLine[] = [];
  let subtotal = dec(0);
  let discountTotal = dec(0);
  let totalAmount = dec(0);

  for (let index = 0; index < input.length; index += 1) {
    const source = input[index]!;
    if (!isIsoCalendarDate(source.serviceDate)) {
      return { ok: false, message: `Line ${index + 1} needs a valid service date.` };
    }
    if (isSaturday(source.serviceDate)) {
      return { ok: false, message: `Line ${index + 1} is on a Saturday. Choose another date.` };
    }
    if (source.serviceDate < servicePeriodStart || source.serviceDate > servicePeriodEnd) {
      return { ok: false, message: `Line ${index + 1} is outside the invoice service period.` };
    }

    const activityId = source.activityId?.trim() || null;
    const activity = activityId ? activities.get(activityId) : undefined;
    if (activityId && !activity) {
      return { ok: false, message: `Line ${index + 1} uses an unavailable class activity.` };
    }
    const description = source.description?.trim() || activity?.name || "";
    if (!description) {
      return { ok: false, message: `Line ${index + 1} needs a class activity or description.` };
    }

    try {
      const quantity = dec(source.quantity ?? "1");
      const unitPrice = dec(source.unitPrice ?? activity?.defaultUnitPrice ?? DEFAULT_CLASS_UNIT_PRICE);
      const discount = dec(source.discountAmount ?? "0");
      if (!quantity.isFinite() || quantity.lte(0)) {
        return { ok: false, message: `Line ${index + 1} needs a quantity greater than zero.` };
      }
      if (!unitPrice.isFinite() || unitPrice.lt(0)) {
        return { ok: false, message: `Line ${index + 1} needs a non-negative price.` };
      }
      if (!discount.isFinite() || discount.lt(0)) {
        return { ok: false, message: `Line ${index + 1} has an invalid discount.` };
      }
      // Normalize the operands before multiplying so this calculation exactly
      // matches PostgreSQL numeric(10,4) * numeric(14,4), including unusual
      // fractional quantities. Invoice totals then sum these stored line values.
      const storedQuantity = dec(quantity.toFixed(4));
      const storedUnitPrice = dec(toMoney(unitPrice));
      const storedDiscount = dec(toMoney(discount));
      const gross = storedQuantity.times(storedUnitPrice);
      if (storedDiscount.gt(gross)) {
        return { ok: false, message: `Line ${index + 1} has an invalid discount.` };
      }
      const storedLineTotal = dec(toMoney(gross.minus(storedDiscount)));
      const sortOrder = Number.isInteger(source.sortOrder) ? Number(source.sortOrder) : index;
      lines.push({
        activityId,
        serviceDate: source.serviceDate,
        description,
        quantity: storedQuantity.toFixed(4),
        unitPrice: storedUnitPrice.toFixed(4),
        discountAmount: storedDiscount.toFixed(4),
        lineTotal: storedLineTotal.toFixed(4),
        sortOrder,
        notes: source.notes?.trim() || null,
      });
      subtotal = subtotal.plus(storedLineTotal).plus(storedDiscount);
      discountTotal = discountTotal.plus(storedDiscount);
      totalAmount = totalAmount.plus(storedLineTotal);
    } catch {
      return { ok: false, message: `Line ${index + 1} has an invalid number.` };
    }
  }

  return {
    ok: true,
    lines,
    subtotal: toMoney(subtotal),
    discountTotal: toMoney(discountTotal),
    totalAmount: toMoney(totalAmount),
  };
}

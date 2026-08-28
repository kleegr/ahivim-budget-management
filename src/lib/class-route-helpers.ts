import {
  apiClassFinancialUser,
  canAccessClassIndividual,
  type ClassFinancialAccess,
} from "@/lib/auth/class-financial-access";
import type { ClassInvoiceLineInput } from "@/lib/business/class-invoicing";
import { getClassInvoice, type ClassInvoiceRecord } from "@/lib/data/class-invoices";
import { jsonError } from "@/lib/http";

type AccessibleClassInvoiceResult =
  | { error: Response }
  | { access: ClassFinancialAccess; invoice: ClassInvoiceRecord };

export function classInvoiceLinesFromRequest(value: unknown): ClassInvoiceLineInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line): line is Record<string, unknown> => Boolean(
      line && typeof line === "object" && !Array.isArray(line),
    ))
    .map((line) => ({
      activityId: typeof line.activityId === "string" ? line.activityId : null,
      serviceDate: String(line.serviceDate ?? ""),
      description: typeof line.description === "string" ? line.description : null,
      quantity: line.quantity === undefined ? undefined : String(line.quantity),
      unitPrice: line.unitPrice === undefined ? undefined : String(line.unitPrice),
      discountAmount: line.discountAmount === undefined ? undefined : String(line.discountAmount),
      sortOrder: line.sortOrder === undefined ? null : Number(line.sortOrder),
      notes: typeof line.notes === "string" ? line.notes : null,
    }));
}

export async function accessibleClassInvoice(
  id: string,
  mode: "view" | "manage",
): Promise<AccessibleClassInvoiceResult> {
  const access = await apiClassFinancialUser(mode);
  if (!access) {
    return {
      error: jsonError(
        mode === "view" ? "Class financial access required" : "Class invoice management access required",
        403,
      ),
    };
  }
  const invoice = await getClassInvoice(access.pool, id);
  if (!invoice) return { error: jsonError("That class invoice was not found.", 404) };
  if (!canAccessClassIndividual(access.scope, invoice.individualId)) {
    return { error: jsonError("You do not have access to that individual's class finances.", 403) };
  }
  return { access, invoice };
}

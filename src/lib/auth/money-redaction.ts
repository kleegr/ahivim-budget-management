import type { VisibilityPermissions } from "@/lib/auth/access";

export type TransactionFieldVisibility = Pick<
  VisibilityPermissions,
  | "canSeeMoney"
  | "canSeeHours"
  | "canSeeBilledAmounts"
  | "canSeeEmployeeAmounts"
  | "canSeeAgencySpread"
  | "canSeeCheckGross"
  | "canSeeCheckNet"
  | "canSeeTaxes"
>;

const HOURS_FIELDS = ["hours", "allocationHours", "physicalHours"] as const;
const BILLED_FIELDS = ["rate", "gross", "amount", "agencyGross"] as const;
const EMPLOYEE_FIELDS = [
  "internalAmount",
  "employeeRate",
  "employeePaymentAmount",
  "totalPayment",
  "paidToEmployee",
  "payableByAgency",
  "unknownRecipient",
] as const;
const SPREAD_FIELDS = ["agencyAdditional", "agencyAdditionalAmount"] as const;
const CHECK_GROSS_FIELDS = ["verifiedCheckGross"] as const;
const CHECK_NET_FIELDS = [
  "totalNetPay",
  "verifiedCheckNet",
  "net",
  "netPay",
] as const;
const CHECK_STATUS_FIELDS = ["verificationStatus"] as const;
const TAX_FIELDS = ["withheld", "withholding", "tax", "taxes"] as const;

type TransactionSensitiveField =
  | (typeof HOURS_FIELDS)[number]
  | (typeof BILLED_FIELDS)[number]
  | (typeof EMPLOYEE_FIELDS)[number]
  | (typeof SPREAD_FIELDS)[number]
  | (typeof CHECK_GROSS_FIELDS)[number]
  | (typeof CHECK_NET_FIELDS)[number]
  | (typeof CHECK_STATUS_FIELDS)[number]
  | (typeof TAX_FIELDS)[number];

type TransactionSensitiveShape = Partial<Record<TransactionSensitiveField, string | null>>;

/** Effective transaction visibility, with the legacy money flag as master guard. */
export function transactionFieldVisibility(
  permissions?: VisibilityPermissions,
): TransactionFieldVisibility {
  if (!permissions) {
    return {
      canSeeMoney: true,
      canSeeHours: true,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: true,
      canSeeAgencySpread: true,
      canSeeCheckGross: true,
      canSeeCheckNet: true,
      canSeeTaxes: true,
    };
  }
  const canSeeMoney = permissions.canSeeMoney !== false;
  return {
    canSeeMoney,
    canSeeHours: permissions.canSeeHours !== false,
    canSeeBilledAmounts: canSeeMoney && permissions.canSeeBilledAmounts !== false,
    canSeeEmployeeAmounts: canSeeMoney && permissions.canSeeEmployeeAmounts !== false,
    canSeeAgencySpread: canSeeMoney && permissions.canSeeAgencySpread !== false,
    canSeeCheckGross: canSeeMoney && permissions.canSeeCheckGross !== false,
    canSeeCheckNet: canSeeMoney && permissions.canSeeCheckNet !== false,
    canSeeTaxes: canSeeMoney && permissions.canSeeTaxes !== false,
  };
}

/**
 * Remove disallowed fields in the server read-model path. Hidden columns cannot
 * be recovered from RSC props, exports, browser state or the detail drawer.
 */
export function redactTransactionFields<T extends TransactionSensitiveShape>(
  row: T,
  permissions?: VisibilityPermissions,
): T {
  const visibility = transactionFieldVisibility(permissions);
  const hidden = new Set<string>();
  if (!visibility.canSeeHours) HOURS_FIELDS.forEach((field) => hidden.add(field));
  if (!visibility.canSeeBilledAmounts) BILLED_FIELDS.forEach((field) => hidden.add(field));
  if (!visibility.canSeeEmployeeAmounts) EMPLOYEE_FIELDS.forEach((field) => hidden.add(field));
  if (!visibility.canSeeAgencySpread) SPREAD_FIELDS.forEach((field) => hidden.add(field));
  if (!visibility.canSeeCheckGross) CHECK_GROSS_FIELDS.forEach((field) => hidden.add(field));
  if (!visibility.canSeeCheckNet) CHECK_NET_FIELDS.forEach((field) => hidden.add(field));
  if (!visibility.canSeeCheckGross && !visibility.canSeeCheckNet) {
    CHECK_STATUS_FIELDS.forEach((field) => hidden.add(field));
  }
  if (!visibility.canSeeTaxes) TAX_FIELDS.forEach((field) => hidden.add(field));
  if (hidden.size === 0) return row;

  const redacted = { ...row } as T & Record<string, unknown>;
  for (const field of hidden) {
    if (Object.prototype.hasOwnProperty.call(redacted, field)) Reflect.set(redacted, field, null);
  }
  return redacted;
}

/** Compatibility helper for callers that only have the legacy master switch. */
export function redactTransactionMoney<T extends TransactionSensitiveShape>(
  row: T,
  canSeeMoney: boolean,
): T {
  return redactTransactionFields(row, {
    canSeeMoney,
    canSeeHours: true,
    canSeeBilledAmounts: true,
    canSeeEmployeeAmounts: true,
    canSeeAgencySpread: true,
    canSeeCheckGross: true,
    canSeeCheckNet: true,
    canSeeTaxes: true,
    canSeeBudgets: true,
    canSeeEmployeeDeals: true,
    canSeeSettlements: true,
    canSeeClassFinancials: true,
    canManageClassInvoices: true,
  });
}

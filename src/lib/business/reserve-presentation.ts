import { dec, formatMoney } from "@/lib/money";

/** Presentation only: amounts remain the canonical ledger's verified subtotal. */
export function reservePresentation(input: {
  setupHistoryAvailable: boolean;
  ledgerDirty: boolean;
  activePlans: number;
  actionablePlans: number;
  reviewRequiredPlans: number;
  missingRenewalPlans: number;
  approvedMonthlyPlan?: string;
  expectedBalancePlans?: number;
  missingBalanceRenewalPlans?: number;
}) {
  const missingRenewals = input.missingBalanceRenewalPlans ?? input.missingRenewalPlans;
  const incomplete = input.reviewRequiredPlans > 0 || missingRenewals > 0
    || (input.actionablePlans < (input.expectedBalancePlans ?? input.activePlans)
      && (input.approvedMonthlyPlan === undefined || !dec(input.approvedMonthlyPlan).eq(0)));
  const unavailable = !input.setupHistoryAvailable || input.ledgerDirty
    || (incomplete && input.actionablePlans === 0);
  const status = !input.setupHistoryAvailable ? "History unavailable"
    : input.ledgerDirty ? "Refresh needed"
    : input.reviewRequiredPlans > 0 ? "Source review required; held balances excluded"
    : missingRenewals > 0 ? "Renewal date needed; incomplete balances excluded"
    : incomplete ? "Ledger incomplete; untracked plans excluded"
    : "Verified balance";
  return {
    unavailable,
    incomplete,
    status,
    label: unavailable ? "Unavailable" : incomplete ? "Verified subtotal" : "Verified balance",
    amount: (value: string): string | null => unavailable ? null : value,
    display: (value: string): string => unavailable ? "Unavailable"
      : incomplete ? `${formatMoney(value)} verified subtotal` : formatMoney(value),
  };
}

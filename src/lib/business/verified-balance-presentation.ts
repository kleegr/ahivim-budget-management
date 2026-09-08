import { toMoney } from "@/lib/money";

/** Describe the same scoped ledger subtotal without treating excluded rows as zero. */
export function verifiedBalancePresentation(held: number, verified: number) {
  const unavailable = held > 0 && verified === 0;
  return {
    amount: (value: string | number | null | undefined): string | null => unavailable ? null : toMoney(value ?? 0),
    status: held > 0
      ? unavailable ? "Source review required" : "Verified subtotal; held items excluded"
      : undefined,
  };
}

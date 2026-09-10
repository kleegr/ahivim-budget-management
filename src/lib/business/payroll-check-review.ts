export type PayrollCheckReviewStatus = "all" | "unverified" | "verified" | "void";

export interface PayrollCheckReviewFilters {
  search?: string;
  status?: string;
  page?: number;
}

export function payrollCheckReviewFilters(input: PayrollCheckReviewFilters = {}) {
  return {
    search: (input.search ?? "").trim().slice(0, 250),
    status: (["unverified", "verified", "void"].includes(input.status ?? "")
      ? input.status : "all") as PayrollCheckReviewStatus,
    page: Number.isSafeInteger(input.page) && input.page! > 0 ? input.page! : 1,
  };
}

/** Check facts and collection eligibility are separate facts. A successful
 * refresh does not establish that a collectible obligation exists. */
export function payrollCheckVerificationNotice(input: {
  linkedTransactions?: number;
  settlementWarning?: string | null;
}): { tone: "success" | "warning"; message: string; needsSourceReview: boolean } {
  const noSources = input.linkedTransactions === 0;
  const message = noSources
    ? "Check facts verified. No linked services were found, so no collection amount was created from this check. Review the employee's billed activity."
    : typeof input.linkedTransactions === "number"
      ? `Check facts verified with ${input.linkedTransactions.toLocaleString()} linked ${input.linkedTransactions === 1 ? "service" : "services"}. Review money operations for collection eligibility and amounts.`
      : "Check facts verified. Review money operations for collection eligibility and amounts.";
  return {
    tone: noSources || input.settlementWarning ? "warning" : "success",
    message: input.settlementWarning ? `${message} Money calculations need refresh: ${input.settlementWarning}` : message,
    needsSourceReview: noSources,
  };
}

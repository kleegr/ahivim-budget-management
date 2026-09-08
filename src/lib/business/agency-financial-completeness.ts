import type { AgencyFinancialCoverage } from "@/lib/data/agency-financial-report";

/** Excluded uncertain actuals make the result provisional; resolved duplicates
 * and unreceived invoice references do not represent missing actual expenses. */
export function agencyFinancialResultIncomplete(coverage: AgencyFinancialCoverage): boolean {
  return [
    coverage.transactionsMissingAmount,
    coverage.agencyTransactionsMissingBase,
    coverage.agencyTransactionsMissingPayRule,
    coverage.directTransactionsMissingVerifiedCheck,
    coverage.directChecksMissingGross,
    coverage.directChecksMissingWithholding,
    coverage.directChecksGrossBelowNet,
    coverage.directChecksMissingDeal,
    coverage.setupsMissingApprovedFinal,
    coverage.setAsideHistoriesUnavailable,
    coverage.unknownPaymentRecipients,
  ].some((count) => count > 0);
}

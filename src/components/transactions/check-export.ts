import type { TransactionFieldVisibility } from "@/lib/auth/money-redaction";
import type { ExportCell, ExportColumn } from "@/lib/export/tabular";
import { amountCompletenessLabel, type CheckSummary } from "./check-grouping";
const VERIFICATION_LABEL: Record<string, string> = { unverified: "Needs verification", verified: "Verified", void: "Void" };

/** Both download formats use these exact nullable values and completeness cells. */
export function buildCheckExport(checks: CheckSummary[], visibility: TransactionFieldVisibility) {
    const columns: ExportColumn[] = [
      { key: "checkNumber", header: "Check #", type: "text" },
      { key: "checkDate", header: "Check date", type: "date" },
      { key: "employee", header: "Employee", type: "text" },
      { key: "payTo", header: "Pay to", type: "text" },
      { key: "routing", header: "Routing", type: "text" },
      { key: "periodBegin", header: "Period begin", type: "date" },
      { key: "periodEnd", header: "Period end", type: "date" },
      { key: "individuals", header: "People served", type: "text" },
      { key: "programs", header: "Programs", type: "text" },
      { key: "services", header: "Recorded services", type: "int" },
      ...(visibility.canSeeHours ? [{ key: "hours", header: "Hours", type: "hours" } as const] : []),
      ...(visibility.canSeeBilledAmounts ? [{ key: "funderBilled", header: "Funder billed", type: "money" } as const, { key: "funderBilledCompleteness", header: "Funder billed completeness", type: "text" } as const] : []),
      ...(visibility.canSeeEmployeeAmounts ? [{ key: "employeeBase", header: "Employee base", type: "money" } as const, { key: "employeeBaseCompleteness", header: "Employee base completeness", type: "text" } as const] : []),
      ...(visibility.canSeeAgencySpread ? [{ key: "agencySpread", header: "Agency spread", type: "money" } as const, { key: "agencySpreadCompleteness", header: "Agency spread completeness", type: "text" } as const] : []),
      ...(visibility.canSeeCheckGross ? [
        { key: "verifiedGross", header: "Verified check gross", type: "money" } as const,
      ] : []),
      ...(visibility.canSeeCheckNet ? [
        { key: "verifiedNet", header: "Verified check net", type: "money" } as const,
        { key: "sourceNet", header: "Source net", type: "money" } as const,
      ] : []),
      ...(visibility.canSeeCheckGross || visibility.canSeeCheckNet
        ? [{ key: "verification", header: "Verification", type: "text" } as const]
        : []),
      ...(visibility.canSeeTaxes ? [{ key: "withholding", header: "Withholding", type: "money" } as const] : []),
      { key: "review", header: "Review status", type: "text" },
    ];
    const exportRows: Record<string, ExportCell>[] = checks.map((check) => ({
      checkNumber: check.checkNumber,
      checkDate: check.checkDate,
      employee: check.employee,
      payTo: check.payTo,
      routing: check.routing === "direct" ? "Direct to employee" : check.routing === "agency" ? "Agency-routed" : "Routing review",
      periodBegin: check.periodBegin,
      periodEnd: check.periodEnd,
      individuals: check.individuals.join(", "),
      programs: check.programs.join(", "),
      services: check.rows,
      hours: check.hours,
      funderBilled: check.funderBilled,
      funderBilledCompleteness: amountCompletenessLabel(check.completeness.funderBilled),
      employeeBase: check.employeeBase,
      employeeBaseCompleteness: amountCompletenessLabel(check.completeness.employeeBase),
      agencySpread: check.agencySpread,
      agencySpreadCompleteness: amountCompletenessLabel(check.completeness.agencySpread),
      verifiedGross: check.verifiedCheckGross,
      verifiedNet: check.verifiedCheckNet,
      verification: check.verificationStatus === null ? "Not linked" : VERIFICATION_LABEL[check.verificationStatus] ?? check.verificationStatus,
      sourceNet: check.netPay,
      withholding: check.withholding,
      review: check.needsReview ? check.reviewReasons.join("; ") : "Ready",
    }));
  return { columns, rows: exportRows };
}

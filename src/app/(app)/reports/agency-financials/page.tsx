import { CircleDollarSign } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import {
  getAgencyFinancialReport,
  agencyFinancialMonthRange,
  listAgencyFinancialOptions,
  normalizeActualAgencyFinancialMonth,
} from "@/lib/data/agency-financial-report";
import {
  listEmployeeIndividualCompensationTerms,
  listManualIncomeEntries,
  listProgramRevenueTerms,
} from "@/lib/manage/agency-financials";
import AgencyFinancialWorkspace from "@/components/reports/agency-financial-workspace";
import { ErrorPanel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency Financials - Ahivim" };

export default async function AgencyFinancialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("admin");
  const params = await searchParams;
  const requested = Array.isArray(params.month) ? params.month[0] : params.month;
  const month = normalizeActualAgencyFinancialMonth(requested);
  const range = agencyFinancialMonthRange(month);
  const result = await withDb(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [report, options, programTerms, employeeTerms, incomeHistory] = await Promise.all([
        getAgencyFinancialReport(client, month),
        listAgencyFinancialOptions(client),
        listProgramRevenueTerms(client),
        listEmployeeIndividualCompensationTerms(client),
        listManualIncomeEntries(client, {
          from: range.start,
          to: range.endInclusive,
          includeVoided: true,
        }),
      ]);
      await client.query("COMMIT");
      return { report, options, programTerms, employeeTerms, incomeHistory };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  return (
    <>
      <PageHeader
        eyebrow="Owner only"
        title="Agency financials"
        description="Actual income and the expenses tied to it. No budgets or projections are counted as income."
        meta={<><CircleDollarSign aria-hidden className="h-3.5 w-3.5" /> Income and expenses stay separated to their source records.</>}
      />
      {!result.ok ? (
        <ErrorPanel title="Agency financials could not load">{result.error}</ErrorPanel>
      ) : (
        <AgencyFinancialWorkspace {...result.data} />
      )}
    </>
  );
}

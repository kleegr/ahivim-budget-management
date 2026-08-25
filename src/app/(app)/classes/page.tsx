import { redirect } from "next/navigation";
import ClassesWorkspace from "@/components/classes/classes-workspace";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { resolveAccessScope } from "@/lib/auth/access";
import { canAccessClassIndividual } from "@/lib/auth/class-financial-access";
import { requireUser } from "@/lib/auth/session";
import {
  listClassActivities,
  listClassBudgets,
  listClassInvoices,
} from "@/lib/data/class-invoices";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";

export const dynamic = "force-dynamic";
export const metadata = { title: "Classes - Ahivim Budget Management" };

const YEAR_MONTH = /^\d{4}-\d{2}$/;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ClassesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const params = await searchParams;
  const requestedMonth = one(params.month);
  const month = requestedMonth && YEAR_MONTH.test(requestedMonth)
    ? requestedMonth
    : new Date().toISOString().slice(0, 7);

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    if (!scope.canSeeClassFinancials) return { denied: true as const };

    const [activities, budgets, invoices, individuals] = await Promise.all([
      listClassActivities(pool, scope, scope.canManageClassInvoices),
      listClassBudgets(pool, scope),
      listClassInvoices(pool, scope),
      listIndividualsManaged(pool, { status: "active", scope }),
    ]);

    return {
      denied: false as const,
      activities,
      budgets,
      invoices,
      individuals: individuals
        .filter((individual) => canAccessClassIndividual(scope, individual.id))
        .map((individual) => ({
          id: individual.id,
          label: individual.displayName,
        })),
      canManage: scope.canManageClassInvoices,
      canEditDocuments: scope.canEditDocuments,
    };
  });

  if (result.ok && result.data.denied) redirect("/home?denied=1");

  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Classes"
        description="Monthly class billing, annual allowances, and invoice history by individual."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load class billing">{result.error}</ErrorPanel>
      ) : result.data.denied ? null : (
        <ClassesWorkspace
          initialMonth={month}
          activities={result.data.activities}
          budgets={result.data.budgets}
          invoices={result.data.invoices}
          individuals={result.data.individuals}
          canManage={result.data.canManage}
          canEditDocuments={result.data.canEditDocuments}
        />
      )}
    </>
  );
}

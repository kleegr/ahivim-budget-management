import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getEmployeeReport } from "@/lib/data/queries";
import { isUuid, listTransactions } from "@/lib/data/app-queries";
import {
  Card, Table, Th, Td, Tr, Money, Hours, EmptyState, ErrorPanel, PageHeader, StatTile, ButtonLink, Badge, Plain,
} from "@/components/ui";
import { formatHours } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employee — Ahivim Budget Management" };

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("viewer");
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await withDb(async (pool) => {
    const report = await getEmployeeReport(pool, id);
    if (!report) return null;
    const recent = await listTransactions(pool, { employeeId: id, limit: 25 });
    return { report, recent };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Employee" title="Employee" />
        <ErrorPanel title="Could not load this employee">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();
  const { report: r, recent } = result.data;

  return (
    <>
      <PageHeader
        eyebrow="Employee"
        title={r.employee.displayName}
        description={r.programs.length ? `Programs: ${r.programs.join(", ")}` : "No programs recorded."}
        action={<ButtonLink href="/employees">All employees</ButtonLink>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Physical hours" value={`${formatHours(r.physicalHours)} h`} hint="Time present; a group session counts once" />
        <StatTile label="Allocation hours" value={`${formatHours(r.allocationHours)} h`} hint="Sum of every individual's entitlement" />
        <StatTile label="Individuals served" value={r.individualsServed.toLocaleString()} hint={`${r.groupSessions} group sessions`} />
        <StatTile label="Agency gross" value={`$${Number(r.agencyGross).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} hint={`Internal $${Number(r.internalAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
      </div>

      <p className="mt-3 max-w-prose text-xs text-[var(--color-ink-faint)]">
        Physical and allocation hours are deliberately separate. A 13-hour session with three
        individuals is 13 physical hours and 39 allocation hours; reporting 39 as hours worked would
        overstate this employee&rsquo;s time threefold.
      </p>

      {r.rateExceptions > 0 ? (
        <div className="mt-4">
          <ErrorPanel title={`${r.rateExceptions} rate exceptions on this employee's rows`}>
            <p>The imported rates were preserved exactly. See Exceptions for the full list.</p>
          </ErrorPanel>
        </div>
      ) : null}

      <div className="mt-6">
        <Card title="Recent transactions" description="Most recent 25 rows for this employee">
          {recent.rows.length === 0 ? (
            <EmptyState title="No transactions recorded" />
          ) : (
            <Table head={<><Th>Check</Th><Th>Individual</Th><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Rate</Th><Th numeric>Amount</Th><Th>Group</Th></>}>
              {recent.rows.map((t) => (
                <Tr key={t.id}>
                  <Td>
                    <Plain value={t.checkNumber} />
                    <p className="text-xs text-[var(--color-ink-faint)]"><Plain value={t.checkDate} /></p>
                  </Td>
                  <Td><Plain value={t.individual} /></Td>
                  <Td><Plain value={t.program} /></Td>
                  <Td numeric><Hours value={t.hours} /></Td>
                  <Td numeric><Money value={t.rate} /></Td>
                  <Td numeric><Money value={t.amount} /></Td>
                  <Td>{t.isGroup ? <Badge value="valid" label="group" /> : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

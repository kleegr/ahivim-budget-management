import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listEmployees } from "@/lib/data/app-queries";
import { Card, Table, Th, Td, Tr, Money, Hours, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employees — Ahivim Budget Management" };

export default async function EmployeesPage() {
  await requireUser("viewer");
  const result = await withDb(listEmployees);

  return (
    <>
      <PageHeader
        eyebrow="Register"
        title="Employees"
        description="Hours here are physical hours: the time the employee was actually present. A group session counts once."
      />
      {!result.ok ? (
        <ErrorPanel title="Could not load employees">{result.error}</ErrorPanel>
      ) : (
        <Card>
          {result.data.length === 0 ? (
            <EmptyState title="No employees are on file">
              <p>Employees are created when a workbook is committed.</p>
            </EmptyState>
          ) : (
            <Table
              caption="Employees with physical hours and agency gross"
              head={<><Th>Employee</Th><Th numeric>Transactions</Th><Th numeric>Individuals</Th><Th numeric>Physical hours</Th><Th numeric>Agency gross</Th></>}
            >
              {result.data.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <Link className="underline underline-offset-2" href={`/employees/${row.id}`}>
                      {row.displayName}
                    </Link>
                  </Td>
                  <Td numeric className="tnum">{row.transactionCount.toLocaleString()}</Td>
                  <Td numeric className="tnum">{row.individualsServed.toLocaleString()}</Td>
                  <Td numeric><Hours value={row.physicalHours} /></Td>
                  <Td numeric><Money value={row.agencyGross} /></Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

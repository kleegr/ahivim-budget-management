import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividuals } from "@/lib/data/queries";
import { Card, Table, Th, Td, Tr, Money, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individuals — Ahivim Budget Management" };

export default async function IndividualsPage() {
  await requireUser("viewer");
  const result = await withDb(listIndividuals);

  return (
    <>
      <PageHeader
        eyebrow="Register"
        title="Individuals"
        description="Everyone with authorized services. Used hours come from service allocations, so a group participant is credited the full session hours."
      />
      {!result.ok ? (
        <ErrorPanel title="Could not load individuals">{result.error}</ErrorPanel>
      ) : (
        <Card>
          {result.data.length === 0 ? (
            <EmptyState title="No individuals are on file">
              <p>
                Individuals are created when a workbook is committed. Import the Ahivim sheet and
                the people it names appear here.
              </p>
            </EmptyState>
          ) : (
            <Table
              caption="Individuals with transaction counts and agency gross"
              head={<><Th>Individual</Th><Th numeric>Transactions</Th><Th numeric>Agency gross</Th></>}
            >
              {result.data.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <Link className="underline underline-offset-2" href={`/individuals/${row.id}`}>
                      {row.displayName}
                    </Link>
                  </Td>
                  <Td numeric className="tnum">{row.transactionCount.toLocaleString()}</Td>
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

import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { exceptionCounts } from "@/lib/data/queries";
import { listPendingAliases, listRateExceptions } from "@/lib/data/app-queries";
import {
  Card, Table, Th, Td, Tr, Money, EmptyState, ErrorPanel, PageHeader, StatTile, Badge, Plain, Pagination,
} from "@/components/ui";
import { formatPercent } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exceptions — Ahivim Budget Management" };

const PAGE_SIZE = 100;

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("manager");
  const sp = await searchParams;
  const first = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const offset = Math.max(0, Number(first("offset") ?? 0) || 0);

  const result = await withDb(async (pool) => ({
    counts: await exceptionCounts(pool),
    rates: await listRateExceptions(pool, { limit: PAGE_SIZE, offset }),
    aliases: await listPendingAliases(pool),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Data exceptions"
        description="Resolve unknown programs, unexpected rates, and duplicate source rows."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load exceptions">{result.error}</ErrorPanel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Rate exceptions" value={result.data.counts.rateExceptions.toLocaleString()} tone={result.data.counts.rateExceptions ? "warn" : "good"} />
            <StatTile label="Unknown programs" value={result.data.counts.unknownPrograms.toLocaleString()} tone={result.data.counts.unknownPrograms ? "warn" : "good"} />
            <StatTile label="Unmatched names" value={result.data.counts.unmatchedNames.toLocaleString()} tone={result.data.counts.unmatchedNames ? "warn" : "good"} />
            <StatTile label="Pending aliases" value={result.data.counts.pendingAliases.toLocaleString()} tone={result.data.counts.pendingAliases ? "warn" : "good"} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Duplicate candidates" value={result.data.counts.duplicateCandidates.toLocaleString()} />
            <StatTile label="Group review issues" value={result.data.counts.groupReviewIssues.toLocaleString()} tone={result.data.counts.groupReviewIssues ? "warn" : "good"} />
            <StatTile label="Reconciliation differences" value={result.data.counts.reconciliationDifferences.toLocaleString()} tone={result.data.counts.reconciliationDifferences ? "warn" : "good"} />
            <StatTile label="Over authorization" value={result.data.counts.overAuthorization.toLocaleString()} tone={result.data.counts.overAuthorization ? "alert" : "good"} />
          </div>

          <div className="mt-6 space-y-4">
            <Card
              title="Rate exceptions"
              description="An imported rate that does not sit on the configured schedule. Self-Hire Respite is configured at $18; a $23 row is preserved exactly as imported and flagged here."
            >
              {result.data.rates.rows.length === 0 ? (
                <EmptyState title="No rate exceptions recorded">
                  <p>Every imported rate matched its effective-dated schedule, or nothing has been imported yet.</p>
                </EmptyState>
              ) : (
                <>
                  <Table
                    caption="Rate exceptions ordered by variance"
                    head={<><Th>Individual</Th><Th>Program</Th><Th numeric>Imported</Th><Th numeric>Expected</Th><Th numeric>Variance</Th><Th numeric>%</Th><Th>State</Th><Th>Source</Th></>}
                  >
                    {result.data.rates.rows.map((x) => (
                      <Tr key={x.id}>
                        <Td><Plain value={x.individual} /></Td>
                        <Td><Plain value={x.program} /></Td>
                        <Td numeric><Money value={x.importedRate} /></Td>
                        <Td numeric><Money value={x.expectedRate} /></Td>
                        <Td numeric><Money value={x.varianceAmount} /></Td>
                        <Td numeric className="tnum">{formatPercent(x.variancePercent)}</Td>
                        <Td><Badge value={x.resolution} /></Td>
                        <Td>
                          <span className="text-xs text-[var(--color-ink-faint)]">
                            {x.checkNumber ? `check ${x.checkNumber}` : ""}
                            {x.sourceRowNumber ? ` r${x.sourceRowNumber}` : ""}
                          </span>
                        </Td>
                      </Tr>
                    ))}
                  </Table>
                  <Pagination basePath="/exceptions" total={result.data.rates.total} limit={PAGE_SIZE} offset={offset} />
                </>
              )}
            </Card>

            <Card
              title="Alias candidates awaiting approval"
              description="Near-duplicate names are never merged automatically. A person approves them, and only then do they match on future imports."
            >
              {result.data.aliases.length === 0 ? (
                <EmptyState title="No alias approvals outstanding" />
              ) : (
                <Table head={<><Th>Kind</Th><Th>Alias</Th><Th>Source text</Th><Th>Would match</Th></>}>
                  {result.data.aliases.map((a) => (
                    <Tr key={`${a.kind}-${a.id}`}>
                      <Td>{a.kind}</Td>
                      <Td><code className="text-xs">{a.alias}</code></Td>
                      <Td>{a.sourceText}</Td>
                      <Td>{a.targetName}</Td>
                    </Tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

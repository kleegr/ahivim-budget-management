import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listTransactions } from "@/lib/data/app-queries";
import { listPrograms } from "@/lib/data/app-queries";
import {
  Card, Table, Th, Td, Tr, Money, Hours, EmptyState, ErrorPanel, PageHeader, StatTile, Badge, Plain, Pagination,
} from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transactions — Ahivim Budget Management" };

const PAGE_SIZE = 50;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("viewer");
  const sp = await searchParams;
  const first = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const search = first("q") ?? "";
  const programCode = first("program") ?? "";
  const offset = Math.max(0, Number(first("offset") ?? 0) || 0);

  const result = await withDb(async (pool) => ({
    page: await listTransactions(pool, {
      search: search || undefined,
      programCode: programCode || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    programs: await listPrograms(pool),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Ledger"
        title="Transactions"
        description="Committed payroll rows. Every row traces back to a source file and row number."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load transactions">{result.error}</ErrorPanel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="Rows matching" value={result.data.page.total.toLocaleString()} />
            <StatTile label="Agency gross" value={`$${Number(result.data.page.totals.agencyGross).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} hint="Sum over the current filter" />
            <StatTile label="Internal amount" value={`$${Number(result.data.page.totals.internalAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} hint="Sum over the current filter" />
          </div>

          <form className="mt-4 flex flex-wrap items-end gap-3" method="get" action="/transactions">
            <div>
              <label className="block text-sm font-medium" htmlFor="q">Search</label>
              <input
                id="q" name="q" type="search" defaultValue={search}
                placeholder="Name or check number"
                className="mt-1 rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium" htmlFor="program">Program</label>
              <select
                id="program" name="program" defaultValue={programCode}
                className="mt-1 rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
              >
                <option value="">All programs</option>
                {result.data.programs.map((p) => (
                  <option key={p.code} value={p.code}>{p.name}</option>
                ))}
              </select>
            </div>
            <button type="submit" className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white">
              Apply
            </button>
            {search || programCode ? (
              <Link className="text-sm underline underline-offset-2" href="/transactions">Clear</Link>
            ) : null}
          </form>

          <div className="mt-4">
            <Card>
              {result.data.page.rows.length === 0 ? (
                <EmptyState title={search || programCode ? "No transactions match this filter" : "No transactions have been committed"}>
                  <p>
                    {search || programCode
                      ? "Try a wider search, or clear the filter."
                      : "Commit an import and the payroll rows it produces appear here."}
                  </p>
                </EmptyState>
              ) : (
                <>
                  <Table
                    caption="Committed payroll transactions"
                    head={<><Th>Check</Th><Th>Individual</Th><Th>Employee</Th><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Rate</Th><Th numeric>Amount</Th><Th numeric>Internal</Th><Th>Source</Th></>}
                  >
                    {result.data.page.rows.map((t) => (
                      <Tr key={t.id}>
                        <Td>
                          <Plain value={t.checkNumber} />
                          <p className="text-xs text-[var(--color-ink-faint)]"><Plain value={t.checkDate} /></p>
                        </Td>
                        <Td><Plain value={t.individual} /></Td>
                        <Td><Plain value={t.employee} /></Td>
                        <Td>
                          <Plain value={t.program} />
                          {t.isGroup ? <Badge value="valid" label="group" /> : null}
                        </Td>
                        <Td numeric><Hours value={t.hours} /></Td>
                        <Td numeric><Money value={t.rate} /></Td>
                        <Td numeric><Money value={t.amount} /></Td>
                        <Td numeric><Money value={t.internalAmount} /></Td>
                        <Td>
                          <span className="text-xs text-[var(--color-ink-faint)]">
                            {t.sourceFile ? `${t.sourceFile} r${t.sourceRowNumber ?? "?"}` : "—"}
                          </span>
                        </Td>
                      </Tr>
                    ))}
                  </Table>
                  <Pagination
                    basePath="/transactions"
                    total={result.data.page.total}
                    limit={PAGE_SIZE}
                    offset={offset}
                    params={{ q: search || undefined, program: programCode || undefined }}
                  />
                </>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { exceptionCounts } from "@/lib/data/queries";
import {
  ACTIONABLE_IMPORT_WARNING_CATEGORIES,
  listActionableImportWarnings,
  listCommittedDuplicateWarnings,
  listPendingAliases,
  listRateExceptions,
  type ActionableImportWarningCategory,
} from "@/lib/data/app-queries";
import {
  Card, Table, Th, Td, Tr, Money, EmptyState, ErrorPanel, PageHeader, StatTile, Badge, Plain, Pagination, ButtonLink,
} from "@/components/ui";
import { formatPercent } from "@/lib/money";
import {
  exceptionQueueHref,
  importCorrectionsHref,
  importIssueCopy,
  individualBudgetHref,
  type ExceptionQueue,
} from "@/lib/nav/review-actions";
import RateExceptionActions from "@/components/exceptions/rate-exception-actions";
import DuplicateWarningActions from "@/components/exceptions/duplicate-warning-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exceptions — Ahivim Budget Management" };

const PAGE_SIZE = 100;
const QUEUES = new Set<ExceptionQueue>(["all", "rate", "unknown_program", "unmatched_name", "possible_duplicate"]);

function categoriesFor(queue: ExceptionQueue): ActionableImportWarningCategory[] {
  if (queue === "unknown_program") return ["unknown_program"];
  if (queue === "unmatched_name") return ["unmatched_individual", "unmatched_employee", "ambiguous_name"];
  return [...ACTIONABLE_IMPORT_WARNING_CATEGORIES];
}

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
  const requestedKind = first("kind") as ExceptionQueue | undefined;
  const kind: ExceptionQueue = requestedKind && QUEUES.has(requestedKind) ? requestedKind : "all";
  const offset = Math.max(0, Number(first("offset") ?? 0) || 0);
  const showRates = kind === "all" || kind === "rate";
  const showImportIssues = kind === "all" || kind === "unknown_program" || kind === "unmatched_name";
  const showDuplicates = kind === "all" || kind === "possible_duplicate";

  const result = await withDb(async (pool) => {
    const [counts, rates, aliases, importIssues, duplicateIssues] = await Promise.all([
      exceptionCounts(pool),
      showRates
        ? listRateExceptions(pool, { resolution: "open", limit: PAGE_SIZE, offset })
        : Promise.resolve({ rows: [], total: 0 }),
      listPendingAliases(pool),
      showImportIssues
        ? listActionableImportWarnings(pool, { categories: categoriesFor(kind), limit: PAGE_SIZE, offset })
        : Promise.resolve({ rows: [], total: 0 }),
      showDuplicates
        ? listCommittedDuplicateWarnings(pool, { limit: PAGE_SIZE, offset })
        : Promise.resolve({ rows: [], total: 0 }),
    ]);
    return { counts, rates, aliases, importIssues, duplicateIssues };
  });

  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Data exceptions"
        description="Resolve unknown programs, unexpected rates, and duplicate source rows."
      />

      {!result.ok ? (
        <ErrorPanel title="Exceptions are unavailable">{result.error}</ErrorPanel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Rate exceptions" value={result.data.counts.rateExceptions.toLocaleString()} tone={result.data.counts.rateExceptions ? "warn" : "good"} href={exceptionQueueHref("rate")} />
            <StatTile label="Unknown programs" value={result.data.counts.unknownPrograms.toLocaleString()} tone={result.data.counts.unknownPrograms ? "warn" : "good"} href={exceptionQueueHref("unknown_program")} />
            <StatTile label="Unmatched names" value={result.data.counts.unmatchedNames.toLocaleString()} tone={result.data.counts.unmatchedNames ? "warn" : "good"} href={exceptionQueueHref("unmatched_name")} />
            <StatTile label="Pending aliases" value={result.data.counts.pendingAliases.toLocaleString()} tone={result.data.counts.pendingAliases ? "warn" : "good"} href="/aliases?status=pending" />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Duplicate candidates" value={result.data.counts.duplicateCandidates.toLocaleString()} href={exceptionQueueHref("possible_duplicate")} />
            <StatTile label="Group review issues" value={result.data.counts.groupReviewIssues.toLocaleString()} tone={result.data.counts.groupReviewIssues ? "warn" : "good"} href="/reconciliation/groups?status=needs_review" />
            <StatTile label="Reconciliation differences" value={result.data.counts.reconciliationDifferences.toLocaleString()} tone={result.data.counts.reconciliationDifferences ? "warn" : "good"} href="/imports?view=reconciliation" />
            <StatTile label="Over authorization" value={result.data.counts.overAuthorization.toLocaleString()} tone={result.data.counts.overAuthorization ? "alert" : "good"} href="/individuals?view=over" />
          </div>

          <div className="mt-5 flex flex-wrap gap-2" aria-label="Exception type">
            {([
              ["all", "All"],
              ["unknown_program", "Unknown programs"],
              ["unmatched_name", "Unmatched names"],
              ["possible_duplicate", "Duplicate rows"],
              ["rate", "Rates"],
            ] as Array<[ExceptionQueue, string]>).map(([queue, label]) => (
              <ButtonLink key={queue} href={exceptionQueueHref(queue)} variant={kind === queue ? "primary" : "secondary"}>
                {label}
              </ButtonLink>
            ))}
          </div>

          <div className="mt-4 space-y-4">
            {showImportIssues ? (
              <Card
                title={kind === "unknown_program" ? "Unknown programs" : kind === "unmatched_name" ? "Unmatched names" : "Imported rows to review"}
                description="Each action opens the exact source row with the relevant correction controls."
              >
                {result.data.importIssues.rows.length === 0 ? (
                  <EmptyState title="No imported rows need this decision" />
                ) : (
                  <>
                    <Table head={<><Th>Issue</Th><Th>Import</Th><Th>Row</Th><Th>Individual</Th><Th>What to do</Th><Th><span className="sr-only">Open</span></Th></>}>
                      {result.data.importIssues.rows.map((issue) => (
                        <Tr key={issue.id}>
                          <Td><Badge value={issue.rowStatus} label={issue.category.replace(/_/g, " ")} /></Td>
                          <Td>{issue.filename}</Td>
                          <Td className="tnum">{issue.sourceRowNumber ?? "—"}</Td>
                          <Td><Plain value={issue.individualName} /></Td>
                          <Td>{importIssueCopy(issue.category, issue.message)}</Td>
                          <Td><ButtonLink href={importCorrectionsHref(issue.fileId, issue.importRowId)} variant="primary">Fix row</ButtonLink></Td>
                        </Tr>
                      ))}
                    </Table>
                    <Pagination basePath="/exceptions" total={result.data.importIssues.total} limit={PAGE_SIZE} offset={offset} params={{ kind: kind === "all" ? undefined : kind }} />
                  </>
                )}
              </Card>
            ) : null}

            {showDuplicates ? (
              <Card
                title="Possible duplicate transactions"
                description="These source rows were imported and counted. Inspect the exact ledger entry and its import history before deciding whether any follow-up is needed."
              >
                {result.data.duplicateIssues.rows.length === 0 ? (
                  <EmptyState title="No committed duplicate candidates" />
                ) : (
                  <>
                    <Table head={<><Th>Import</Th><Th>Row</Th><Th>Individual</Th><Th>Employee</Th><Th>Check</Th><Th>Why flagged</Th><Th>Actions</Th></>}>
                      {result.data.duplicateIssues.rows.map((issue) => (
                        <Tr key={issue.id}>
                          <Td>{issue.filename}</Td>
                          <Td className="tnum">{issue.sourceRowNumber}</Td>
                          <Td><Plain value={issue.individualName} /></Td>
                          <Td><Plain value={issue.employeeName} /></Td>
                          <Td>
                            <div>{issue.checkNumber ?? "-"}</div>
                            <div className="text-xs text-[var(--color-ink-faint)]">
                              {issue.periodBegin && issue.periodEnd ? `${issue.periodBegin} to ${issue.periodEnd}` : "No pay period"}
                            </div>
                          </Td>
                          <Td>{issue.message}</Td>
                          <Td>
                            <DuplicateWarningActions
                              warningId={issue.id}
                              transactionId={issue.transactionId}
                              sourceFileId={issue.fileId}
                              importRowId={issue.importRowId}
                            />
                          </Td>
                        </Tr>
                      ))}
                    </Table>
                    <Pagination basePath="/exceptions" total={result.data.duplicateIssues.total} limit={PAGE_SIZE} offset={offset} params={{ kind: kind === "all" ? undefined : kind }} />
                  </>
                )}
              </Card>
            ) : null}

            {showRates ? (
              <Card
                title="Unexpected rates"
                description="Accept a legitimate source rate without changing its transaction, or inspect the source and configured schedule."
                action={(
                  <div className="flex flex-wrap gap-2">
                    <ButtonLink href="/reconciliation/groups" variant="secondary">Group rates</ButtonLink>
                    <ButtonLink href="/settings#programs" variant="secondary">Rate setup</ButtonLink>
                  </div>
                )}
              >
                {result.data.rates.rows.length === 0 ? (
                  <EmptyState title="No open rate exceptions" />
                ) : (
                  <>
                    <Table
                      caption="Open rate exceptions ordered by variance"
                      head={<><Th>Individual</Th><Th>Program</Th><Th numeric>Imported</Th><Th numeric>Expected</Th><Th numeric>Variance</Th><Th numeric>%</Th><Th>Source</Th><Th>Actions</Th></>}
                    >
                      {result.data.rates.rows.map((exception) => (
                        <Tr key={exception.id}>
                          <Td>
                            {exception.individualId
                              ? <Link className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={individualBudgetHref(exception.individualId)}>{exception.individual ?? "Individual"}</Link>
                              : <Plain value={exception.individual} />}
                          </Td>
                          <Td><Plain value={exception.program} /></Td>
                          <Td numeric><Money value={exception.importedRate} /></Td>
                          <Td numeric><Money value={exception.expectedRate} /></Td>
                          <Td numeric><Money value={exception.varianceAmount} /></Td>
                          <Td numeric className="tnum">{formatPercent(exception.variancePercent)}</Td>
                          <Td>
                            <span className="text-xs text-[var(--color-ink-faint)]">
                              {exception.checkNumber ? `check ${exception.checkNumber}` : ""}
                              {exception.sourceRowNumber ? ` row ${exception.sourceRowNumber}` : ""}
                            </span>
                          </Td>
                          <Td>
                            <RateExceptionActions
                              exceptionId={exception.id}
                              transactionId={exception.transactionId}
                              sourceFileId={exception.sourceFileId}
                              importRowId={exception.importRowId}
                            />
                          </Td>
                        </Tr>
                      ))}
                    </Table>
                    <Pagination basePath="/exceptions" total={result.data.rates.total} limit={PAGE_SIZE} offset={offset} params={{ kind: kind === "all" ? undefined : kind }} />
                  </>
                )}
              </Card>
            ) : null}

            {kind === "all" ? (
              <Card
                title="Name spellings awaiting approval"
                description="Approve a spelling only when it is safe to reuse for future imports."
                action={<ButtonLink href="/aliases?status=pending">Review spellings</ButtonLink>}
              >
                {result.data.aliases.length === 0 ? (
                  <EmptyState title="No spelling approvals are waiting" />
                ) : (
                  <Table head={<><Th>Kind</Th><Th>Imported spelling</Th><Th>Would match</Th></>}>
                    {result.data.aliases.map((alias) => (
                      <Tr key={`${alias.kind}-${alias.id}`}>
                        <Td>{alias.kind}</Td>
                        <Td><code className="text-xs">{alias.sourceText}</code></Td>
                        <Td>{alias.targetName}</Td>
                      </Tr>
                    ))}
                  </Table>
                )}
              </Card>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}

import { CheckCircle2, Eye, Inbox, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { exceptionCounts } from "@/lib/data/queries";
import { ButtonLink, Card, EmptyState, ErrorPanel, PageHeader, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import { reviewQueueHref } from "@/lib/nav/review-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review — Ahivim Budget Management" };

/*
  The Review inbox.

  Six admin screens used to compete for attention — Matches, Aliases,
  Exceptions, Sync review, Reconciliation differences, import corrections.
  They are all the same sentence: "the system couldn't be sure, a person
  needs to decide."

  This page gathers those into one destination organised by TYPE OF
  DECISION. Each row states the question in plain language, shows how many
  items are waiting, and offers a single link to the exact screen where you
  can act.

  The count going to zero is the goal.
*/

type Section = {
  key: string;
  question: string;
  detail: string;
  href: string;
  count: number;
  tone: "warn" | "danger" | "info";
};

const statusFor = (tone: Section["tone"], monitoring = false) => {
  if (monitoring) return <StatusBadge tone="info" label="Monitor" />;
  if (tone === "danger") return <StatusBadge tone="danger" label="Action needed" />;
  return <StatusBadge tone="warn" label="Decision needed" />;
};

export default async function ReviewPage() {
  await requireUser("manager");

  const result = await withDb((pool) => exceptionCounts(pool));

  if (!result.ok) {
    return (
      <>
        <PageHeader
          eyebrow="Inbox"
          title="Review inbox"
          description="Decisions waiting for a person."
        />
        <ErrorPanel title="Review inbox is unavailable">{result.error}</ErrorPanel>
      </>
    );
  }

  const c = result.data;

  // Decisions: a person must act, and until they do something is unresolved.
  const decisions: Section[] = [
    {
      key: "names",
      question: "Imported names need a match",
      detail: "Choose the correct individual or employee on each source row.",
      href: reviewQueueHref("unmatched_names"),
      count: c.unmatchedNames,
      tone: "warn",
    },
    {
      key: "aliases",
      question: "Name spellings need approval",
      detail: "Approve a spelling before the system reuses it on future imports.",
      href: reviewQueueHref("pending_aliases"),
      count: c.pendingAliases,
      tone: "warn",
    },
    {
      key: "duplicates",
      question: "Possible duplicate people",
      detail: "Confirm whether two records belong to the same person.",
      href: reviewQueueHref("duplicate_people"),
      count: c.duplicateIndividuals,
      tone: "warn",
    },
    {
      key: "programs",
      question: "Unknown programs",
      detail: "Map source values to a program before they enter billed activity.",
      href: reviewQueueHref("unknown_programs"),
      count: c.unknownPrograms,
      tone: "warn",
    },
    {
      key: "reconcile",
      question: "Source totals do not reconcile",
      detail: "Review a difference between imported control totals and committed activity.",
      href: reviewQueueHref("reconciliation"),
      count: c.reconciliationDifferences,
      tone: "info",
    },
  ];

  // Worth watching: informational. Nothing is excluded from totals and no decision
  // is required to keep the ledger correct — these are signals, not a to-do list.
  const monitoring: Section[] = [
    {
      key: "rates",
      question: "Unexpected rates",
      detail: "Billed activity used a rate outside the configured schedule.",
      href: reviewQueueHref("rates"),
      count: c.rateExceptions,
      tone: "info",
    },
    {
      key: "groups",
      question: "Group sessions to confirm",
      detail: "Confirm whether related rows represent one shared service session.",
      href: reviewQueueHref("groups"),
      count: c.groupReviewIssues,
      tone: "info",
    },
    {
      key: "duprows",
      question: "Possible duplicate rows",
      detail: "Two committed rows share the same source details.",
      href: reviewQueueHref("duplicate_rows"),
      count: c.duplicateCandidates,
      tone: "info",
    },
    {
      key: "over",
      question: "Over authorization",
      detail: "Billed hours have passed the current authorization.",
      href: reviewQueueHref("over_authorization"),
      count: c.overAuthorization,
      tone: "danger",
    },
  ];

  const total = decisions.reduce((s, x) => s + x.count, 0);
  const active = decisions.filter((s) => s.count > 0);
  const watching = monitoring.filter((s) => s.count > 0);

  return (
    <>
      <PageHeader
        eyebrow="Inbox"
        title="Review inbox"
        description="Resolve imported identities, source mappings, and exceptions that require judgment."
      />

      <div className="mb-5 grid grid-cols-3 divide-x divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
        <InboxMetric label="Waiting" value={total} tone={total ? "danger" : "good"} icon={<Inbox aria-hidden className="h-4 w-4" />} />
        <InboxMetric label="Decision queues" value={active.length} tone={active.length ? "warn" : "good"} icon={<ShieldCheck aria-hidden className="h-4 w-4" />} />
        <InboxMetric label="Monitoring" value={watching.reduce((sum, section) => sum + section.count, 0)} tone="info" icon={<Eye aria-hidden className="h-4 w-4" />} />
      </div>

      {total === 0 ? (
        <Card>
          <EmptyState title="No decisions waiting" icon={<CheckCircle2 aria-hidden className="h-5 w-5" />}>
            New items appear here when an import or sync needs review.
          </EmptyState>
        </Card>
      ) : (
        <Card title="Needs decision" description={`${total.toLocaleString()} item${total === 1 ? "" : "s"} across ${active.length.toLocaleString()} queues`}>
          <Table head={<><Th>Status</Th><Th>Queue</Th><Th numeric>Waiting</Th><Th><span className="sr-only">Open</span></Th></>}>
            {active.map((section) => (
              <Tr key={section.key}>
                <Td>{statusFor(section.tone)}</Td>
                <Td>
                  <p className="font-semibold text-[var(--color-ink)]">{section.question}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{section.detail}</p>
                </Td>
                <Td numeric><span className="text-lg font-semibold">{section.count.toLocaleString()}</span></Td>
                <Td><ButtonLink href={section.href}>Review</ButtonLink></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      )}

      {watching.length > 0 ? (
        <Card className="mt-6" title="Monitoring" description="Signals already included in system totals">
          <Table head={<><Th>Status</Th><Th>Signal</Th><Th numeric>Items</Th><Th><span className="sr-only">Open</span></Th></>}>
            {watching.map((section) => (
              <Tr key={section.key}>
                <Td>{statusFor(section.tone, true)}</Td>
                <Td>
                  <p className="font-semibold text-[var(--color-ink)]">{section.question}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{section.detail}</p>
                </Td>
                <Td numeric><span className="text-lg font-semibold">{section.count.toLocaleString()}</span></Td>
                <Td><ButtonLink href={section.href}>Open</ButtonLink></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </>
  );
}

function InboxMetric({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: "danger" | "warn" | "good" | "info";
  icon: ReactNode;
}) {
  const color = tone === "danger" ? "var(--color-danger)" : tone === "warn" ? "var(--color-warn)" : tone === "good" ? "var(--color-success)" : "var(--color-info)";
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="flex items-center gap-2 text-[var(--color-ink-faint)]">{icon}<span className="eyebrow truncate">{label}</span></div>
      <p className="tnum mt-1 text-xl font-semibold" style={{ color }}>{value.toLocaleString()}</p>
    </div>
  );
}

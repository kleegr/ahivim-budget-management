import { CheckCircle2, Eye, Inbox, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getActivityReviewSummary } from "@/lib/data/activity-overview";
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

  const result = await withDb((pool) => getActivityReviewSummary(pool));

  if (!result.ok) {
    return (
      <>
        <PageHeader
          eyebrow="Activity"
          title="Activity review"
          description="Decisions waiting for a person."
          action={<ButtonLink href="/transactions">Back to activity</ButtonLink>}
        />
        <ErrorPanel title="Review inbox is unavailable">{result.error}</ErrorPanel>
      </>
    );
  }

  const { decisions: d, monitoring: m } = result.data;

  // Decisions: a person must act, and until they do something is unresolved.
  const decisions: Section[] = [
    {
      key: "source",
      question: "Did the original activity change?",
      detail: "Compare changed or missing source records before choosing what Ahivim should keep.",
      href: reviewQueueHref("sync_conflicts"),
      count: d.changedSourceRecords + d.missingSourceRecords,
      tone: "warn",
    },
    {
      key: "names",
      question: "Who does this service belong to?",
      detail: "Choose the correct individual or employee when a name was not recognized.",
      href: reviewQueueHref("unmatched_names"),
      count: d.unmatchedNames,
      tone: "warn",
    },
    {
      key: "aliases",
      question: "Can this name be reused?",
      detail: "Approve a spelling before Ahivim recognizes it automatically next time.",
      href: reviewQueueHref("pending_aliases"),
      count: d.pendingAliases,
      tone: "warn",
    },
    {
      key: "duplicates",
      question: "Are these the same person?",
      detail: "Confirm whether two records belong to the same person.",
      href: reviewQueueHref("duplicate_people"),
      count: d.duplicatePeople,
      tone: "warn",
    },
    {
      key: "programs",
      question: "Which program was provided?",
      detail: "Choose the correct program before the service can enter recorded activity.",
      href: reviewQueueHref("unknown_programs"),
      count: d.unknownPrograms,
      tone: "warn",
    },
    {
      key: "reconcile",
      question: "Do these totals match the original record?",
      detail: "Review a difference between the original totals and recorded activity.",
      href: reviewQueueHref("reconciliation"),
      count: d.totalDifferences,
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
      count: m.unexpectedRates,
      tone: "info",
    },
    {
      key: "groups",
      question: "Group sessions to confirm",
      detail: "Confirm whether related rows represent one shared service session.",
      href: reviewQueueHref("groups"),
      count: m.groupServices,
      tone: "info",
    },
    {
      key: "duprows",
      question: "Possible duplicate services",
      detail: "Two recorded services share the same original details.",
      href: reviewQueueHref("duplicate_rows"),
      count: m.possibleDuplicateServices,
      tone: "info",
    },
    {
      key: "over",
      question: "Over authorization",
      detail: "Billed hours have passed the current authorization.",
      href: reviewQueueHref("over_authorization"),
      count: m.overAuthorization,
      tone: "danger",
    },
  ];

  const total = result.data.decisionTotal;
  const active = decisions.filter((s) => s.count > 0);
  const watching = monitoring.filter((s) => s.count > 0);

  return (
    <>
      <PageHeader
        eyebrow="Activity"
        title="Activity review"
        description="Answer the questions that keep recorded services and payroll from being fully ready."
        action={<ButtonLink href="/transactions">Back to activity</ButtonLink>}
      />

      <div className="mb-5 grid grid-cols-3 divide-x divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
        <InboxMetric label="Waiting" value={total} tone={total ? "danger" : "good"} icon={<Inbox aria-hidden className="h-4 w-4" />} />
        <InboxMetric label="Decision queues" value={active.length} tone={active.length ? "warn" : "good"} icon={<ShieldCheck aria-hidden className="h-4 w-4" />} />
        <InboxMetric label="Monitoring" value={watching.reduce((sum, section) => sum + section.count, 0)} tone="info" icon={<Eye aria-hidden className="h-4 w-4" />} />
      </div>

      {total === 0 ? (
        <Card>
          <EmptyState title="No decisions waiting" icon={<CheckCircle2 aria-hidden className="h-5 w-5" />}>
            New items appear here when a name, program, source change, or total needs judgment.
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
                <Td><ButtonLink href={section.href}>Decide</ButtonLink></Td>
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

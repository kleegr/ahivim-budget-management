import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { exceptionCounts } from "@/lib/data/queries";
import { Card, PageHeader, ErrorPanel } from "@/components/ui";

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

function toneClasses(tone: "warn" | "danger" | "info") {
  switch (tone) {
    case "danger":
      return {
        chip: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
        count: "text-[var(--color-danger)]",
        edge: "border-l-[var(--color-danger)]",
      };
    case "info":
      return {
        chip: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
        count: "text-[var(--color-info)]",
        edge: "border-l-[var(--color-info)]",
      };
    default:
      return {
        chip: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
        count: "text-[var(--color-warn)]",
        edge: "border-l-[var(--color-warn)]",
      };
  }
}

export default async function ReviewPage() {
  await requireUser("viewer");

  const result = await withDb((pool) => exceptionCounts(pool));

  if (!result.ok) {
    return (
      <>
        <PageHeader
          eyebrow="Inbox"
          title="Review"
          description="Everything the system can't decide on its own — gathered in one place."
        />
        <ErrorPanel title="Couldn't load the review inbox">{result.error}</ErrorPanel>
      </>
    );
  }

  const c = result.data;

  // Decisions: a person must act, and until they do something is unresolved.
  const decisions: Section[] = [
    {
      key: "names",
      question: "Unknown or misspelled names",
      detail:
        "A name the import couldn't resolve on its own — ambiguous, or an alias waiting to be approved. Approve it once and the system matches it automatically from then on.",
      href: "/aliases",
      count: c.unmatchedNames + c.pendingAliases,
      tone: "warn",
    },
    {
      key: "duplicates",
      question: "Possible duplicate people",
      detail:
        "Two records that look like the same person spelled differently. Merging lines up their transactions, budget and financial plan under one identity.",
      href: "/matches",
      count: c.duplicateIndividuals,
      tone: "warn",
    },
    {
      key: "programs",
      question: "Unknown programs",
      detail:
        "An import row referenced a program the system doesn't know, so it was held out of the ledger. Map it to the right program to include the row.",
      href: "/exceptions",
      count: c.unknownPrograms,
      tone: "warn",
    },
    {
      key: "reconcile",
      question: "Sheet doesn't agree with the system",
      detail:
        "An import batch flagged a difference between the workbook control totals and the system totals. Look and decide which is right.",
      href: "/reconciliation",
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
      detail:
        "A billed rate that doesn't sit on the configured schedule for that program. The row is imported and counted at its real rate; review only if the schedule looks wrong.",
      href: "/exceptions",
      count: c.rateExceptions,
      tone: "info",
    },
    {
      key: "groups",
      question: "Group sessions to confirm",
      detail:
        "Rows that may be one shared group session. Every row is already billed to its own individual; confirming only folds them into a single physical session for scheduling.",
      href: "/reconciliation/groups",
      count: c.groupReviewIssues,
      tone: "info",
    },
    {
      key: "duprows",
      question: "Possible duplicate rows",
      detail:
        "Two ledger rows share every detail. Both were imported and counted (the sheet counts them too); open them only to confirm they aren't an accidental double-entry.",
      href: "/exceptions",
      count: c.duplicateCandidates,
      tone: "info",
    },
    {
      key: "over",
      question: "Over authorization",
      detail:
        "One or more budgets have billed more hours than were approved this period. Adjust the authorization or accept the overage.",
      href: "/reports/utilization-outliers",
      count: c.overAuthorization,
      tone: "danger",
    },
  ];

  const total = decisions.reduce((s, x) => s + x.count, 0);
  const empty = decisions.filter((s) => s.count === 0);
  const active = decisions.filter((s) => s.count > 0);
  const watching = monitoring.filter((s) => s.count > 0);

  return (
    <>
      <PageHeader
        eyebrow="Inbox"
        title="Review"
        description="Everything the system can't decide on its own, in one place. Clear the list — that's the whole job."
      />

      {total === 0 ? (
        <Card>
          <div className="px-6 py-10 text-center">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-success-soft)] text-2xl text-[var(--color-success)]">
              ✓
            </div>
            <p className="display mt-4 text-lg font-semibold">All clear</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-[var(--color-ink-soft)]">
              Nothing needs a human right now. The system will surface new items here as soon as an
              import or sync finds something it can’t resolve on its own.
            </p>
          </div>
        </Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-[var(--color-ink-soft)]">
            <span className="tnum font-semibold text-[var(--color-ink)]">{total.toLocaleString()}</span>{" "}
            item{total === 1 ? "" : "s"} across{" "}
            <span className="tnum">{active.length}</span> categor{active.length === 1 ? "y" : "ies"}.
          </p>
          <div className="space-y-3">
            {active.map((s) => {
              const t = toneClasses(s.tone);
              return (
                <Link
                  key={s.key}
                  href={s.href}
                  className={`card card-interactive block border-l-4 ${t.edge} px-5 py-4`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide ${t.chip}`}
                        >
                          {s.tone === "danger"
                            ? "Action needed"
                            : s.tone === "info"
                              ? "Please confirm"
                              : "Please decide"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[0.95rem] font-semibold text-[var(--color-ink)]">
                        {s.question}
                      </p>
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{s.detail}</p>
                    </div>
                    <div className="text-right">
                      <p className={`tnum text-2xl font-semibold leading-none ${t.count}`}>
                        {s.count.toLocaleString()}
                      </p>
                      <p className="mt-1 text-[0.65rem] uppercase tracking-wide text-[var(--color-ink-faint)]">
                        waiting
                      </p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          {empty.length > 0 ? (
            <div className="mt-8">
              <p className="eyebrow mb-2">Already clear</p>
              <div className="flex flex-wrap gap-2">
                {empty.map((s) => (
                  <span
                    key={s.key}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-rule)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink-soft)]"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
                    {s.question}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}

      {watching.length > 0 ? (
        <div className="mt-10">
          <p className="eyebrow mb-1">Worth watching</p>
          <p className="mb-3 max-w-prose text-sm text-[var(--color-ink-soft)]">
            Signals, not a to-do list. Nothing here is excluded from any total, and no decision is
            required to keep the ledger correct — these are here so nothing surprising stays hidden.
          </p>
          <div className="space-y-3">
            {watching.map((s) => {
              const t = toneClasses(s.tone);
              return (
                <Link key={s.key} href={s.href} className={`card card-interactive block border-l-4 ${t.edge} px-5 py-4`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{s.question}</p>
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{s.detail}</p>
                    </div>
                    <p className={`tnum text-2xl font-semibold leading-none ${t.count}`}>{s.count.toLocaleString()}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}

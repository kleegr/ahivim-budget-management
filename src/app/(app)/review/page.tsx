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
  const total =
    c.rateExceptions +
    c.unmatchedNames +
    c.pendingAliases +
    c.duplicateCandidates +
    c.groupReviewIssues +
    c.reconciliationDifferences +
    c.overAuthorization +
    c.unknownPrograms;

  const sections: Section[] = [
    {
      key: "names",
      question: "Unknown or misspelled names",
      detail:
        "The import saw a name it doesn't recognise, or a near-duplicate spelling. Approve the spelling once and the system will match it automatically from then on.",
      href: "/aliases",
      count: c.unmatchedNames + c.pendingAliases,
      tone: "warn",
    },
    {
      key: "duplicates",
      question: "Possible duplicate people",
      detail:
        "Two records that look like the same person. Merging them lines up their transactions and budgets under one identity.",
      href: "/matches",
      count: c.duplicateCandidates,
      tone: "warn",
    },
    {
      key: "rates",
      question: "Unexpected rates",
      detail:
        "A billed rate that doesn't sit on the configured schedule for that program. Accept it as a one-off or fix the rate.",
      href: "/exceptions",
      count: c.rateExceptions,
      tone: "warn",
    },
    {
      key: "programs",
      question: "Unknown programs",
      detail:
        "An import row referenced a program code the system doesn't know. Point it at the right program to include the row.",
      href: "/exceptions",
      count: c.unknownPrograms,
      tone: "warn",
    },
    {
      key: "groups",
      question: "Group sessions to confirm",
      detail:
        "The system spotted rows that may be one shared group session. Confirming folds them into a single session with a shared physical-hours count.",
      href: "/exceptions",
      count: c.groupReviewIssues,
      tone: "info",
    },
    {
      key: "reconcile",
      question: "Sheet doesn't agree with the system",
      detail:
        "A recent import batch flagged a difference between the workbook totals and the system totals. Someone needs to look and decide which is right.",
      href: "/reconciliation",
      count: c.reconciliationDifferences,
      tone: "info",
    },
    {
      key: "over",
      question: "Over authorization",
      detail:
        "One or more budgets have used more hours than were approved. Adjust the authorization, or accept the overage on record.",
      href: "/exceptions",
      count: c.overAuthorization,
      tone: "danger",
    },
  ];

  const empty = sections.filter((s) => s.count === 0);
  const active = sections.filter((s) => s.count > 0);

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
              import or sync finds something it can't resolve on its own.
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
                  className={`card block border-l-4 ${t.edge} px-5 py-4 transition hover:shadow-md`}
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
    </>
  );
}

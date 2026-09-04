"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { settlementCheckIssueAction } from "@/components/settlements/deep-links";
import type { DirectCheckIssue, SettlementDashboardData } from "@/lib/data/settlements";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value: string | null): string {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}
function useDeepLinkTarget<Element extends HTMLElement>(active: boolean) {
  const ref = useRef<Element>(null);

  useEffect(() => {
    if (!active || !ref.current) return;
    const target = ref.current;
    const frame = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  return ref;
}

function deepLinkTargetClass(active: boolean): string {
  return active
    ? "scroll-mt-24 outline outline-2 outline-offset-2 outline-[var(--color-primary)]"
    : "scroll-mt-24";
}

function checkIssueReference(issue: DirectCheckIssue): string {
  const parts: string[] = [];
  if (issue.checkNumber) parts.push(`Check ${issue.checkNumber}`);

  if (issue.periodBegin && issue.periodEnd) {
    parts.push(`Pay period ${formatDate(issue.periodBegin)} to ${formatDate(issue.periodEnd)}`);
  } else if (issue.periodBegin || issue.periodEnd) {
    parts.push(`Pay period ${formatDate(issue.periodBegin ?? issue.periodEnd)}`);
  } else if (issue.checkDate) {
    parts.push(`Dated ${formatDate(issue.checkDate)}`);
  }

  return parts.join(" | ") || "Payroll transaction";
}

const CHECK_ISSUE_COPY: Record<DirectCheckIssue["issue"], { label: string; guidance: string }> = {
  missing_check_identity: {
    label: "Missing check identity",
    guidance: "Record the verified check date or pay period so this payment has one canonical identity.",
  },
  missing_net: {
    label: "Verified check needed",
    guidance: "Record the verified whole-check net; imported row values alone are not used for settlement calculations.",
  },
  conflicting_net: {
    label: "Conflicting net",
    guidance: "Record the verified whole-check net once; it becomes canonical for linked rows.",
  },
  conflicting_check_date: {
    label: "Conflicting dates",
    guidance: "Record the verified check identity to resolve conflicting transaction dates.",
  },
  missing_base: {
    label: "Missing base",
    guidance: "Inspect the source rows and correct the employee base or rate before calculating the payout.",
  },
  unknown_recipient: {
    label: "Recipient needed",
    guidance: "Inspect the source rows and choose whether the employee or agency received the payment.",
  },
};

const CHECK_ISSUE_PAGE_SIZE = 25;

function checkIssueSearchText(issue: DirectCheckIssue): string {
  return [
    issue.employeeName,
    issue.checkNumber,
    issue.checkDate,
    issue.periodBegin,
    issue.periodEnd,
    checkIssueReference(issue),
    CHECK_ISSUE_COPY[issue.issue].label,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function CheckIssues({
  data,
  canManagePayrollChecks,
  canSeeTransactions,
  focused,
}: {
  data: SettlementDashboardData;
  canManagePayrollChecks: boolean;
  canSeeTransactions: boolean;
  focused: boolean;
}) {
  const targetRef = useDeepLinkTarget<HTMLElement>(focused);
  const [search, setSearch] = useState("");
  const [issuePage, setIssuePage] = useState(0);
  const deferredSearch = useDeferredValue(search);
  if (data.checkIssues.length === 0) {
    if (!focused) return null;
    return (
      <section
        id="settlement-check-issues"
        ref={targetRef}
        tabIndex={-1}
        className={`${deepLinkTargetClass(true)} border-l-4 border-[var(--color-success)] bg-[var(--color-success-soft)] px-4 py-3`}
        aria-labelledby="direct-check-issues-title"
      >
        <h2 id="direct-check-issues-title" className="text-sm font-semibold text-[var(--color-success)]">All payroll sources are ready</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">There are no check-data problems to fix.</p>
      </section>
    );
  }

  const counts = new Map<DirectCheckIssue["issue"], number>();
  for (const issue of data.checkIssues) counts.set(issue.issue, (counts.get(issue.issue) ?? 0) + 1);
  const searchNeedle = deferredSearch.trim().toLowerCase();
  const filteredIssues = searchNeedle
    ? data.checkIssues.filter((issue) => checkIssueSearchText(issue).includes(searchNeedle))
    : data.checkIssues;
  const issuePageCount = Math.max(1, Math.ceil(filteredIssues.length / CHECK_ISSUE_PAGE_SIZE));
  const currentIssuePage = Math.min(issuePage, issuePageCount - 1);
  const visibleIssueStart = currentIssuePage * CHECK_ISSUE_PAGE_SIZE;
  const visibleIssues = filteredIssues.slice(visibleIssueStart, visibleIssueStart + CHECK_ISSUE_PAGE_SIZE);

  return (
    <section
      id="settlement-check-issues"
      ref={targetRef}
      tabIndex={focused ? -1 : undefined}
      className={deepLinkTargetClass(focused)}
      aria-labelledby="direct-check-issues-title"
    >
      <details open={focused || undefined} className="group border-l-4 border-[var(--color-warn)] bg-[var(--color-warn-soft)]">
        <summary className="cursor-pointer px-4 py-3 marker:text-[var(--color-warn)]">
          <span className="ml-1 inline-flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span id="direct-check-issues-title" className="text-sm font-semibold text-[var(--color-warn)]">
              {data.checkIssues.length} payroll source{data.checkIssues.length === 1 ? " needs" : "s need"} attention
            </span>
            <span className="text-xs text-[var(--color-ink-soft)]">
              {[...counts.entries()].map(([issue, count]) => `${count} ${CHECK_ISSUE_COPY[issue].label.toLowerCase()}`).join("; ")}
            </span>
          </span>
        </summary>

        <div className="border-t border-[var(--color-rule)] px-4 pb-3 pt-2">
          <p id="direct-check-issues-help" className="text-xs leading-5 text-[var(--color-ink-soft)]">
            Direct give-backs use a verified whole-check record; other issues stay tied to their source rows. Resolve the item, then refresh payments.
          </p>
          {data.checkIssues.length > CHECK_ISSUE_PAGE_SIZE || search.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="min-w-56 flex-1 text-xs font-medium text-[var(--color-ink-soft)]">
                Find a payroll source
                <input
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setIssuePage(0);
                  }}
                  placeholder="Employee, check, date, or issue"
                  className="input mt-1 w-full"
                />
              </label>
              <span className="pb-2 text-xs tabular-nums text-[var(--color-ink-faint)]" aria-live="polite">
                {filteredIssues.length === 0
                  ? "No matches"
                  : `Showing ${visibleIssueStart + 1}-${visibleIssueStart + visibleIssues.length} of ${filteredIssues.length}`}
              </span>
            </div>
          ) : null}
          <ul aria-describedby="direct-check-issues-help" className="mt-2 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
            {visibleIssues.map((issue) => {
              const copy = CHECK_ISSUE_COPY[issue.issue];
              const action = settlementCheckIssueAction(issue, {
                canRecordPayrollCheck: canManagePayrollChecks,
                canSeeTransactions,
              });
              return (
                <li key={`${issue.sourceId}:${issue.issue}`} className="grid gap-1 py-2 text-sm sm:grid-cols-[minmax(12rem,1fr)_minmax(16rem,1.5fr)] sm:gap-4">
                  <div className="min-w-0">
                    <Link href={`/employees/${issue.employeeId}?view=checks`} className="font-medium text-[var(--color-primary)] hover:underline">
                      {issue.employeeName}
                    </Link>
                    <p className="truncate text-xs text-[var(--color-ink-faint)]" title={checkIssueReference(issue)}>
                      {checkIssueReference(issue)}
                      {issue.transactionCount > 1 ? ` | ${issue.transactionCount} transactions` : ""}
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-start gap-2">
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-[var(--color-warn)] ring-1 ring-inset ring-[var(--color-warn)]">
                      {copy.label}
                    </span>
                    <span className="min-w-48 flex-1 text-xs leading-5 text-[var(--color-ink-soft)]">
                      {copy.guidance}
                    </span>
                    {action ? (
                      <Link
                        href={action.href}
                        className="shrink-0 text-xs font-semibold leading-5 text-[var(--color-primary)] hover:underline"
                      >
                        {action.label}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {filteredIssues.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--color-ink-soft)]">No payroll sources match that search.</p>
          ) : null}
          {filteredIssues.length > CHECK_ISSUE_PAGE_SIZE ? (
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setIssuePage(Math.max(0, currentIssuePage - 1))}
                disabled={currentIssuePage === 0}
                className="btn btn-sm btn-ghost gap-1"
              >
                <ChevronLeft size={15} aria-hidden="true" />
                Previous
              </button>
              <span className="min-w-20 text-center text-xs tabular-nums text-[var(--color-ink-faint)]">
                Page {currentIssuePage + 1} of {issuePageCount}
              </span>
              <button
                type="button"
                onClick={() => setIssuePage(Math.min(issuePageCount - 1, currentIssuePage + 1))}
                disabled={currentIssuePage >= issuePageCount - 1}
                className="btn btn-sm btn-ghost gap-1"
              >
                Next
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {!canManagePayrollChecks && !canSeeTransactions ? (
            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">An administrator with payroll-check or billed-activity access must resolve these items.</p>
          ) : null}
        </div>
      </details>
    </section>
  );
}

import Link from "next/link";
import { ArrowRight, Clock3 } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { REPORTS } from "@/lib/data/report-queries";
import { PageHeader } from "@/components/ui";
import { REPORT_LIBRARY } from "@/components/reports/report-library";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports - Ahivim Budget Management" };

export default async function ReportsPage() {
  const user = await requireUser("manager");

  return (
    <>
      <PageHeader
        eyebrow="Insights"
        title="Reports"
        description="Choose the decision you need to make. Every report states its time basis, keeps money stages separate, and exports the same filtered rows shown on screen."
      />

      <div className="space-y-10">
        {REPORT_LIBRARY.map((group) => {
          const headingId = `report-group-${group.heading.replaceAll(" ", "-").toLowerCase()}`;
          return (
            <section key={group.heading} aria-labelledby={headingId}>
              <div className="mb-3 border-b border-[var(--color-rule-strong)] pb-3">
                <h2 id={headingId} className="display text-lg font-semibold text-[var(--color-ink)]">
                  {group.heading}
                </h2>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{group.description}</p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {group.reports.map((report) => {
                  if (report.ownerOnly && user.role !== "admin") return null;
                  if (!report.href && !REPORTS[report.key]) return null;
                  const Icon = report.icon;
                  return (
                    <Link
                      key={report.key}
                      href={report.href ?? `/reports/${report.key}`}
                      className="card-interactive group flex min-h-44 flex-col rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-4 outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
                    >
                      <div className="flex items-start gap-3">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
                          <Icon size={18} strokeWidth={1.8} aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <h3 className="display text-base font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
                            {report.title}
                          </h3>
                          <p className="mt-1 text-sm leading-5 text-[var(--color-ink-soft)]">{report.question}</p>
                        </div>
                      </div>

                      <div className="mt-auto flex items-end justify-between gap-3 border-t border-[var(--color-rule)] pt-3">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-ink-faint)]">
                          <Clock3 size={13} className="shrink-0" aria-hidden />
                          <span>{report.timeBasis}</span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-[var(--color-primary)]">
                          Open <ArrowRight size={15} aria-hidden />
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

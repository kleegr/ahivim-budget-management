import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while the dashboard figures are queried. */
export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading dashboard">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-64" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      {/* Workspace buttons */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[4.5rem] w-full rounded-lg" />
        ))}
      </div>

      {/* Headline totals */}
      <Skeleton className="mb-2 mt-6 h-3 w-24" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card px-4 py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-6 w-28" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Two panels */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-5">
            <Skeleton className="h-5 w-40" />
            <div className="mt-3 space-y-2">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-6 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

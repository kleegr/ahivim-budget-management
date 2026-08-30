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

      {/* Responsibility workspaces */}
      <div className="border-y border-[var(--color-rule-strong)] py-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-md" />
                <div className="flex-1">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="mt-2 h-4 w-28" />
                </div>
              </div>
              <Skeleton className="mt-4 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-3/4" />
              <Skeleton className="mt-4 h-4 w-24" />
            </div>
          ))}
        </div>
      </div>

      {/* Money position */}
      <div className="py-8">
        <Skeleton className="mb-4 h-5 w-32" />
        <div className="grid border-y border-[var(--color-rule-strong)] sm:grid-cols-3 sm:divide-x sm:divide-[var(--color-rule)]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="px-5 py-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-7 w-28" />
              <Skeleton className="mt-3 h-3 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

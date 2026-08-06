import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while reconciliation data loads. */
export default function ReconciliationLoading() {
  return (
    <div role="status" aria-label="Loading reconciliation">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-7 w-52" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>

      {/* Stat band */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card px-4 py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-6 w-20" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>

      {/* Filter form */}
      <Skeleton className="mt-4 h-14 w-full rounded-lg" />

      {/* Two lists */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card overflow-hidden">
            <div className="border-b border-[var(--color-rule)] px-5 py-3">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="space-y-2.5 px-5 py-4">
              {Array.from({ length: 6 }).map((_, j) => (
                <Skeleton key={j} className="h-6 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

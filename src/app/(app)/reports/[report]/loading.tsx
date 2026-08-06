import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while a report runs. */
export default function ReportLoading() {
  return (
    <div role="status" aria-label="Loading report">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-64" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
      </div>

      {/* Back link */}
      <Skeleton className="mb-4 h-4 w-24" />

      {/* Filter row */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-40 rounded-md" />
        ))}
        <Skeleton className="h-9 w-20 rounded-md" />
      </div>

      {/* Grid */}
      <div className="overflow-hidden rounded-lg border border-[var(--color-rule-strong)]">
        <Skeleton className="h-9 w-full" />
        <div className="space-y-2 p-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while financial setup loads. */
export default function CalculationsLoading() {
  return (
    <div role="status" aria-label="Loading financial setup">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-48" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
      </div>

      {/* Stat band */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card px-4 py-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-6 w-24" />
            <Skeleton className="mt-2 h-3 w-16" />
          </div>
        ))}
      </div>

      {/* Portfolio pace card */}
      <div className="card mt-3 px-5 py-4">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="mt-2 h-2 w-full rounded-full" />
      </div>

      {/* Toolbar */}
      <div className="mt-3 mb-3 flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-56 rounded-md" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-md" />
        ))}
      </div>

      {/* Grid */}
      <div className="overflow-hidden rounded-lg border border-[var(--color-rule-strong)]">
        <Skeleton className="h-9 w-full" />
        <div className="space-y-2 p-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

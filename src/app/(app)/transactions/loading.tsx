import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while the transactions ledger loads. */
export default function TransactionsLoading() {
  return (
    <div role="status" aria-label="Loading transactions">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-7 w-48" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-56 rounded-md" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-md" />
        ))}
      </div>

      {/* Filter bar */}
      <Skeleton className="mb-3 h-12 w-full rounded-lg" />

      {/* Filtered subtotals */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-5 w-24" />
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="mt-3 overflow-hidden rounded-lg border border-[var(--color-rule-strong)]">
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

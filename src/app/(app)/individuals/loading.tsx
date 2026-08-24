import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while the individuals register loads. */
export default function IndividualsLoading() {
  return (
    <div role="status" aria-label="Loading individuals">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-7 w-44" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      {/* Filter form */}
      <Skeleton className="mb-3 h-16 w-full rounded-lg" />

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="border-b border-[var(--color-rule)] px-5 py-3">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-2.5 px-5 py-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

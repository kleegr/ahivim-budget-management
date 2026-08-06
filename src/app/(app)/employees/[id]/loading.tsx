import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while an employee profile loads. */
export default function EmployeeDetailLoading() {
  return (
    <div role="status" aria-label="Loading employee">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-56" />
          <Skeleton className="mt-2.5 h-4 w-64" />
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-md" />
          ))}
        </div>
      </div>

      {/* Status line */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>

      {/* Tab bar */}
      <div className="mb-4 flex flex-wrap gap-2 border-b border-[var(--color-rule)] pb-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-24 rounded-md" />
        ))}
      </div>

      {/* Stat band */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card px-4 py-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-6 w-24" />
            <Skeleton className="mt-2 h-3 w-16" />
          </div>
        ))}
      </div>

      {/* Detail block */}
      <div className="card mt-6 overflow-hidden">
        <div className="border-b border-[var(--color-rule)] px-5 py-3">
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-2.5 px-5 py-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while the exceptions queue loads. */
export default function ExceptionsLoading() {
  return (
    <div role="status" aria-label="Loading exceptions">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-7 w-44" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
      </div>

      {/* Two rows of stat tiles */}
      {Array.from({ length: 2 }).map((_, row) => (
        <div key={row} className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-4 ${row === 1 ? "mt-3" : ""}`}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-4 py-3.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-6 w-16" />
            </div>
          ))}
        </div>
      ))}

      {/* Table cards */}
      <div className="mt-6 space-y-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card overflow-hidden">
            <div className="border-b border-[var(--color-rule)] px-5 py-3">
              <Skeleton className="h-4 w-48" />
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

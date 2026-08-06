import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while the reports hub loads. */
export default function ReportsLoading() {
  return (
    <div role="status" aria-label="Loading reports">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-40" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
      </div>

      {/* Report groups */}
      <div className="space-y-8">
        {Array.from({ length: 3 }).map((_, s) => (
          <div key={s}>
            <Skeleton className="h-5 w-52" />
            <Skeleton className="mt-1.5 h-3 w-80 max-w-full" />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-2 h-3 w-full" />
                  <Skeleton className="mt-3 h-3 w-32" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

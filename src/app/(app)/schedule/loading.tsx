import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while the schedule calendar loads. */
export default function ScheduleLoading() {
  return (
    <div role="status" aria-label="Loading schedule">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-40" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
      </div>

      {/* Calendar toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-40 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="ml-auto h-8 w-28 rounded-md" />
      </div>

      {/* Filters */}
      <Skeleton className="mb-4 h-11 w-full rounded-lg" />

      {/* Month grid — scrolls horizontally inside its container on small screens */}
      <div className="scroll-thin overflow-x-auto rounded-lg border border-[var(--color-rule)]">
        <div className="min-w-[680px] sm:min-w-0">
          <div className="grid grid-cols-7 gap-px border-b border-[var(--color-rule)] p-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px p-2">
            {Array.from({ length: 35 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

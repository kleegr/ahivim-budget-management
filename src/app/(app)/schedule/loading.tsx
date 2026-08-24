import { Skeleton } from "@/components/ui-viz";

/** Instant route-level placeholder while Planning loads. */
export default function ScheduleLoading() {
  return (
    <div role="status" aria-label="Loading planning workspace">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-40" />
          <Skeleton className="mt-2.5 h-4 w-full max-w-xl" />
        </div>
      </div>

      {/* Portfolio signals */}
      <div className="mb-6 grid gap-px border-y border-[var(--color-rule)] sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-4 py-3 first:pl-0">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-6 w-12" />
            <Skeleton className="mt-2 h-3 w-40 max-w-full" />
          </div>
        ))}
      </div>

      {/* Workspace tabs and first table */}
      <div className="mb-5 flex gap-2 border-b border-[var(--color-rule)] pb-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-28 rounded-md" />)}
      </div>

      <div className="border-y border-[var(--color-rule)] py-3">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
        </div>
      </div>
    </div>
  );
}

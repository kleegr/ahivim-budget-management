export default function AppLoading() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading workspace">
      <div className="h-7 w-52 animate-pulse rounded bg-[var(--color-rule)]" />
      <div className="h-px bg-[var(--color-rule)]" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)]" />
      <span className="sr-only">Loading workspace</span>
    </div>
  );
}

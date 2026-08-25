export default function ClassesLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading Classes">
      <div className="h-8 w-48 animate-pulse rounded bg-[var(--color-rule)]" />
      <div className="h-11 animate-pulse rounded-md bg-[var(--color-rule)]" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-20 animate-pulse rounded-md bg-[var(--color-rule)]" />)}
      </div>
      <div className="h-80 animate-pulse rounded-md bg-[var(--color-rule)]" />
    </div>
  );
}

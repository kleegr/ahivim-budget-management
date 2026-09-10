import type { FilterState } from "@/components/data-grid/types";

export interface InvestigationScope {
  filters: FilterState;
  search: string;
  onChange(next: { filters: FilterState; search: string }): void;
}

export function InvestigationCheckDates({ scope }: { scope: InvestigationScope }) {
  const change = (key: "from" | "to", value: string) => scope.onChange({ ...scope,
    filters: { ...scope.filters, checkDate: { ...scope.filters.checkDate, [key]: value || undefined } } });
  return <fieldset className="flex flex-wrap items-end gap-2">
    <legend className="mb-1 text-xs font-semibold text-[var(--color-ink-soft)]">Check dates · shared across views</legend>
    <label className="text-xs">From<input aria-label="Check date from" type="date" className="input mt-1 block" value={scope.filters.checkDate?.from ?? ""} onChange={(event) => change("from", event.target.value)} /></label>
    <label className="text-xs">To<input aria-label="Check date to" type="date" className="input mt-1 block" value={scope.filters.checkDate?.to ?? ""} onChange={(event) => change("to", event.target.value)} /></label>
  </fieldset>;
}

export function investigationDrillHref(href: string, scope: InvestigationScope | undefined, filters: FilterState): string {
  if (!scope) return href;
  return `${href}&scope=${encodeURIComponent(JSON.stringify({ filters: { ...scope.filters, ...filters }, search: scope.search }))}`;
}

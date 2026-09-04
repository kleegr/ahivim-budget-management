export type BudgetStatusView = "portfolio" | "up_to_date";

export function resolveBudgetStatusView(value: string | undefined): BudgetStatusView {
  return value === "up_to_date" ? "up_to_date" : "portfolio";
}

/** Preserve existing exception/budget filters while changing only the sheet. */
export function budgetStatusViewHref(currentHref: string, view: BudgetStatusView): string {
  const url = new URL(currentHref, "https://ahivim.local");
  if (view === "up_to_date") url.searchParams.set("sheet", "up_to_date");
  else url.searchParams.delete("sheet");
  return `${url.pathname}${url.search}${url.hash}`;
}

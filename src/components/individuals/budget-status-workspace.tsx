"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { LayoutList, TableProperties } from "lucide-react";
import IndividualsList, { type IndividualRow } from "@/components/individuals/individuals-list";
import {
  budgetStatusViewHref,
  type BudgetStatusView,
} from "@/components/individuals/budget-status-view";
import type { PortfolioView } from "@/components/individuals/portfolio-view";
import type { UpToDateBudgetPortfolio } from "@/lib/business/up-to-date-budget";

const UpToDateBudgetSheet = dynamic(() => import("@/components/individuals/up-to-date-budget-sheet"), {
  loading: () => <p role="status" className="py-8 text-sm text-[var(--color-ink-soft)]">Loading authorization periods…</p>,
});

export default function BudgetStatusWorkspace({
  rows,
  upToDate,
  initialView,
  initialFilter,
  canManage,
  canViewUpToDate,
}: {
  rows: IndividualRow[];
  upToDate: UpToDateBudgetPortfolio;
  initialView: BudgetStatusView;
  initialFilter: PortfolioView;
  canManage: boolean;
  canViewUpToDate: boolean;
}) {
  const [view, setView] = useState<BudgetStatusView>(canViewUpToDate ? initialView : "portfolio");

  const selectView = useCallback((nextView: BudgetStatusView) => {
    setView(nextView);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", budgetStatusViewHref(window.location.href, nextView));
    }
  }, []);

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const nextView = event.key === "ArrowLeft" || event.key === "Home"
      ? "portfolio"
      : event.key === "ArrowRight" || event.key === "End"
        ? "up_to_date"
        : null;
    if (!nextView) return;
    event.preventDefault();
    selectView(nextView);
    window.requestAnimationFrame(() => {
      document.getElementById(`budget-status-tab-${nextView === "up_to_date" ? "up-to-date" : nextView}`)?.focus();
    });
  };

  return (
    <div className="space-y-4">
      {canViewUpToDate ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="segmented-control" role="tablist" aria-label="Budget status views">
            <button
              id="budget-status-tab-portfolio"
              type="button"
              role="tab"
              aria-selected={view === "portfolio"}
              tabIndex={view === "portfolio" ? 0 : -1}
              aria-controls="budget-status-panel-portfolio"
              onKeyDown={moveTabFocus}
              onClick={() => selectView("portfolio")}
            >
              <LayoutList aria-hidden className="h-4 w-4" /> Portfolio
            </button>
            <button
              id="budget-status-tab-up-to-date"
              type="button"
              role="tab"
              aria-selected={view === "up_to_date"}
              tabIndex={view === "up_to_date" ? 0 : -1}
              aria-controls="budget-status-panel-up-to-date"
              onKeyDown={moveTabFocus}
              onClick={() => selectView("up_to_date")}
            >
              <TableProperties aria-hidden className="h-4 w-4" /> Up To Date
            </button>
          </div>
          <p className="text-sm text-[var(--color-ink-soft)]">
            {view === "portfolio"
              ? "One operational row per person."
              : "One row per authorization period, with each program kept separate."}
          </p>
        </div>
      ) : null}

      {view === "up_to_date" && canViewUpToDate ? (
        <section
          id="budget-status-panel-up-to-date"
          role="tabpanel"
          aria-labelledby="budget-status-tab-up-to-date"
        >
          <UpToDateBudgetSheet portfolio={upToDate} />
        </section>
      ) : (
        <section
          id="budget-status-panel-portfolio"
          role={canViewUpToDate ? "tabpanel" : undefined}
          aria-labelledby={canViewUpToDate ? "budget-status-tab-portfolio" : undefined}
        >
          <IndividualsList
            key={initialFilter}
            rows={rows}
            initialFilter={initialFilter}
            canManage={canManage}
          />
        </section>
      )}
    </div>
  );
}

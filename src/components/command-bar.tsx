"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ⌘K / Ctrl-K command bar — the fastest path to any screen. For a user coming
 * from a spreadsheet's Ctrl-F reflex, this makes the whole navigation a single
 * keystroke away, and quietly settles the "how many doors?" question for power
 * users: type where you want to go and press Enter.
 */

type Item = { label: string; href: string; hint?: string; keywords?: string };

const ITEMS: Item[] = [
  { label: "Home", href: "/home", hint: "What needs you today", keywords: "dashboard start" },
  { label: "Transactions", href: "/transactions", hint: "What was billed — the source of truth", keywords: "ledger billed payroll" },
  { label: "Individuals", href: "/individuals", hint: "Budgets, usage & people", keywords: "clients participants budget health board" },
  { label: "Employees", href: "/employees", hint: "Activity from the ledger", keywords: "staff workers people" },
  { label: "Financial", href: "/calculations", hint: "Rates, cuts & net", keywords: "calculations money plan cuts projections" },
  { label: "Schedule", href: "/schedule", hint: "Plan sessions on a calendar", keywords: "calendar sessions" },
  { label: "Review", href: "/review", hint: "Clear the inbox", keywords: "exceptions matches aliases reconciliation names rates" },
  { label: "Reports", href: "/reports", hint: "Export & analysis" },
  { label: "Settings & data tools", href: "/settings", hint: "Admin", keywords: "admin sync imports" },
  // The most-opened reports, reachable directly.
  { label: "Report: Budget utilization", href: "/reports/budget-utilization", keywords: "pace off track behind" },
  { label: "Report: Expiring authorizations", href: "/reports/expiring-authorizations", keywords: "renew lapse 60 days" },
  { label: "Report: Utilization outliers", href: "/reports/utilization-outliers", keywords: "over budget behind" },
  { label: "Report: Agency earnings", href: "/reports/agency-earnings", keywords: "money markup total" },
  { label: "Report: Employee payable", href: "/reports/employee-payable", keywords: "owed pay" },
  { label: "Report: Program totals", href: "/reports/program-totals", keywords: "money by program" },
];

export default function CommandBar() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return ITEMS;
    return ITEMS.filter((i) => `${i.label} ${i.hint ?? ""} ${i.keywords ?? ""}`.toLowerCase().includes(needle));
  }, [q]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setActive(0);
  }, []);

  const go = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  // Global ⌘K / Ctrl-K to open (and toggle closed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-bar", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-bar", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [results, active]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command menu"
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--color-rule-strong)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = results[active];
              if (item) go(item.href);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          placeholder="Go to… (type a screen or report)"
          className="w-full border-b border-[var(--color-rule)] bg-transparent px-4 py-3 text-sm outline-none"
          aria-label="Search screens"
        />
        <ul className="max-h-[50vh] overflow-auto py-1">
          {results.map((item, i) => (
            <li key={item.href + item.label}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item.href)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                  i === active ? "bg-[var(--color-primary-tint)] text-[var(--color-primary)]" : "text-[var(--color-ink)] hover:bg-[var(--color-surface-strong)]"
                }`}
              >
                <span className="font-medium">{item.label}</span>
                {item.hint ? <span className="truncate text-xs text-[var(--color-ink-faint)]">{item.hint}</span> : null}
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="px-4 py-6 text-center text-sm text-[var(--color-ink-faint)]">No screen matches “{q}”.</li> : null}
        </ul>
        <div className="flex items-center justify-between border-t border-[var(--color-rule)] px-4 py-2 text-[0.7rem] text-[var(--color-ink-faint)]">
          <span>↑↓ to move · ↵ to open · esc to close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}

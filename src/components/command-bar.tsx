"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { getCommandDestinations, type NavigationAccess } from "@/lib/nav/app-navigation";

export default function CommandBar({
  role = "viewer",
  accessResolved = false,
  canSeeTransactions = false,
  canSeeSettlements = false,
  canSeeBudgets = false,
  canPlan = false,
  canSeeClassFinancials = false,
  canSeeEmployees = false,
  canEditDocuments = false,
  canUsePortal = false,
  canManageAgencies = false,
}: {
  role?: string;
  accessResolved?: boolean;
  canSeeTransactions?: boolean;
  canSeeSettlements?: boolean;
  canSeeBudgets?: boolean;
  canPlan?: boolean;
  canSeeClassFinancials?: boolean;
  canSeeEmployees?: boolean;
  canEditDocuments?: boolean;
  canUsePortal?: boolean;
  canManageAgencies?: boolean;
} = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const access = useMemo<NavigationAccess>(
    () => ({ role, accessResolved, canSeeTransactions, canSeeSettlements, canSeeBudgets, canPlan, canSeeClassFinancials, canSeeEmployees, canEditDocuments, canUsePortal, canManageAgencies }),
    [role, accessResolved, canSeeTransactions, canSeeSettlements, canSeeBudgets, canPlan, canSeeClassFinancials, canSeeEmployees, canEditDocuments, canUsePortal, canManageAgencies],
  );
  const available = useMemo(() => getCommandDestinations(access), [access]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return available;
    return available.filter((item) =>
      `${item.label} ${item.hint} ${item.keywords ?? ""}`.toLowerCase().includes(needle),
    );
  }, [query, available]);

  const show = useCallback(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }, []);

  const go = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) close();
        else show();
      }
    };
    const onOpen = () => show();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("open-command-bar", onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("open-command-bar", onOpen);
    };
  }, [open, close, show]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [results, active]);

  if (!open) return null;

  return (
    <div
      className="overlay-in fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Search Ahivim"
      onClick={close}
    >
      <div
        className="pop-in w-full max-w-lg origin-top overflow-hidden rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center border-b border-[var(--color-rule)] px-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = results[active];
                if (item) go(item.href);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
            placeholder="Search workspaces and reports"
            className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm outline-none"
            aria-label="Search workspaces and reports"
          />
          <button type="button" onClick={close} className="btn btn-sm btn-ghost grid h-8 w-8 place-items-center p-0" aria-label="Close search" title="Close search">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <ul className="max-h-[55vh] overflow-auto py-1">
          {results.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item.href)}
                className={`flex min-h-11 w-full items-center justify-between gap-4 px-4 py-2 text-left text-sm ${
                  index === active
                    ? "bg-[var(--color-primary-tint)] text-[var(--color-primary)]"
                    : "text-[var(--color-ink)] hover:bg-[var(--color-surface-strong)]"
                }`}
              >
                <span className="font-medium">{item.label}</span>
                <span className="truncate text-xs text-[var(--color-ink-faint)]">{item.hint}</span>
              </button>
            </li>
          ))}
          {results.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">No matching destination</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

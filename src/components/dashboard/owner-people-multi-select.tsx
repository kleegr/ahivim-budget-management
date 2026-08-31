"use client";

import { ChevronDown, Search, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { OwnerActivityOption } from "@/lib/dashboard/owner-summary";

export default function OwnerPeopleMultiSelect({
  options,
  selected,
}: {
  options: OwnerActivityOption[];
  selected: string[];
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(() => new Set(selected));
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle))
      : options;
  }, [options, query]);

  const summary = picked.size === 0
    ? "All people"
    : picked.size === 1
      ? options.find((option) => picked.has(option.value))?.label ?? "1 person"
      : `${picked.size} people selected`;

  function toggle(value: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  return (
    <div className="min-w-0 text-xs font-semibold text-[var(--color-ink-soft)]">
      <span>People</span>
      <details className="group relative mt-1">
        <summary className="input flex min-h-10 cursor-pointer list-none items-center gap-2 text-sm font-normal marker:hidden">
          <UsersRound aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
          <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">{summary}</span>
          <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)] transition-transform group-open:rotate-180" />
        </summary>
        <div className="absolute left-0 z-30 mt-1 w-full min-w-72 border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-3 shadow-lg">
          <label className="relative block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
            <input
              type="search"
              className="input w-full pl-9 text-sm font-normal"
              placeholder="Find a person"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="mt-2 flex min-h-10 items-center justify-between gap-3">
            <span className="font-normal text-[var(--color-ink-faint)]">
              {picked.size === 0 ? "Everyone included" : `${picked.size} selected`}
            </span>
            {picked.size > 0 ? (
              <button
                type="button"
                className="touch-target inline-flex items-center gap-1 text-[var(--color-primary)]"
                onClick={() => setPicked(new Set())}
              >
                <X aria-hidden className="h-3.5 w-3.5" /> All people
              </button>
            ) : null}
          </div>
          <div className="scroll-thin max-h-64 overflow-y-auto border-t border-[var(--color-rule)] pt-1">
            {visible.length === 0 ? (
              <p className="px-2 py-3 font-normal text-[var(--color-ink-faint)]">No matching people.</p>
            ) : visible.map((option) => (
              <label
                key={option.value}
                className="flex min-h-10 cursor-pointer items-center gap-2 px-2 font-normal text-[var(--color-ink)] hover:bg-[var(--color-surface-muted)]"
              >
                <input
                  type="checkbox"
                  name="individualId"
                  value={option.value}
                  checked={picked.has(option.value)}
                  onChange={() => toggle(option.value)}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

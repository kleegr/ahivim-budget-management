"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * A one-time orientation for a brand-new user. Accounts are admin-created, so a
 * person's very first visit lands here with no idea where to start; this card
 * names the whole app in four steps, then gets out of the way for good. It is
 * client-only (revealed after mount) so it never causes a hydration mismatch,
 * and the "Got it" choice is remembered in the browser.
 */

const KEY = "ahivim.welcomed.v1";

const STEPS: { n: number; title: string; label: string; href: string; hint: string }[] = [
  { n: 1, title: "Record what happened", label: "Transactions", href: "/transactions", hint: "every billed payroll row — the source of truth" },
  { n: 2, title: "Watch the budgets", label: "Individuals", href: "/individuals", hint: "who's on pace, who's over, what's left" },
  { n: 3, title: "Check the money", label: "Financial", href: "/calculations", hint: "rates, cuts and the net per account" },
  { n: 4, title: "Clear what needs a decision", label: "Review", href: "/review", hint: "the inbox to zero" },
];

export default function FirstRunWelcome() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      /* private mode / storage blocked — just don't show it */
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  return (
    <div className="card mb-6 border-l-4 border-l-[var(--color-primary)] px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow text-[var(--color-primary)]">Welcome to Ahivim</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Four places to work — that&rsquo;s the whole app. Open any one to get started.
          </p>
        </div>
        <button type="button" onClick={dismiss} className="btn btn-sm btn-secondary shrink-0">
          Got it
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-2.5 transition hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-tint)]"
          >
            <span className="flex items-center gap-1.5 text-[0.7rem] font-semibold text-[var(--color-ink-faint)]">
              <span className="grid h-4 w-4 place-items-center rounded-full bg-[var(--color-primary)] text-[0.6rem] text-white">{s.n}</span>
              {s.title}
            </span>
            <span className="mt-1 block text-sm font-semibold text-[var(--color-ink)]">{s.label}</span>
            <span className="block text-xs text-[var(--color-ink-faint)]">{s.hint}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

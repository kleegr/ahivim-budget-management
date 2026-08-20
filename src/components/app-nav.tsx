"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AuthenticatedUser } from "@/lib/auth/session";
import CommandBar from "@/components/command-bar";

/*
  Navigation, redesigned.

  The mental model is deliberately small:

    Home     — one place to see what needs you today
    -----
    Workspaces
      Transactions   — what was actually billed
      Projections    — budgets, pacing and what's left
      People         — individuals and employees, together
    -----
    Overview
      Schedule       — plan sessions on a calendar
      Review · N     — one inbox for everything the system can't decide alone
      Reports        — exports and analysis
    -----
    Admin
      Settings & data tools (rarely opened)

  What used to be 15 top-level doors is now three workspaces, one inbox, and a
  quiet admin drawer. Nothing has been deleted — every legacy screen is still
  reachable — they just stop competing with the daily work.
*/

const ADMIN_ITEMS: { href: string; label: string }[] = [
  { href: "/settings", label: "Settings" },
  { href: "/sync", label: "Sheet sync" },
  { href: "/imports", label: "Imports (backup)" },
  { href: "/reconciliation", label: "Sheet vs. system" },
  { href: "/aliases", label: "Known spellings" },
  { href: "/matches", label: "Name matches" },
  { href: "/exceptions", label: "All flagged items" },
];

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator",
  manager: "Manager",
  viewer: "Viewer",
};

function TransactionsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 4v16" />
    </svg>
  );
}

function ProjectionsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
      <path d="M19 7v3h-3" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3 2.7-5 6-5s6 2 6 5" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M15 20c0-2.4 1.6-4.2 4-4.6" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4M16 3v4" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <path d="M3 13h5l2 3h4l2-3h5" />
      <path d="M3 13V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6" />
      <path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

function ReportsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 16v-4M12 16V8M16 16v-6" />
    </svg>
  );
}

function MasserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v10M9.5 9.2c0-1 1.1-1.7 2.5-1.7s2.5.7 2.5 1.7-1.1 1.6-2.5 1.9-2.5.9-2.5 1.9 1.1 1.7 2.5 1.7 2.5-.7 2.5-1.7" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function Wordmark() {
  return (
    <Link href="/home" className="flex items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-primary)] text-sm font-bold text-white">A</span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-[var(--color-ink)]">Ahivim</span>
        <span className="block text-[0.65rem] text-[var(--color-ink-faint)]">Budget Management</span>
      </span>
    </Link>
  );
}

function PrimaryTile({
  href,
  label,
  sub,
  icon,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  sub: string;
  icon: ReactNode;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
        active
          ? "border-transparent bg-[var(--color-primary)] text-white shadow-sm"
          : "border-[var(--color-rule-strong)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-tint)]"
      }`}
    >
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
          active ? "bg-white/15 text-white" : "bg-[var(--color-primary-tint)] text-[var(--color-primary)]"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-sm font-semibold">{label}</span>
        <span className={`block text-[0.7rem] ${active ? "text-white/80" : "text-[var(--color-ink-faint)]"}`}>{sub}</span>
      </span>
    </Link>
  );
}

function QuietLink({
  href,
  label,
  icon,
  active,
  onNavigate,
  count,
}: {
  href: string;
  label: string;
  icon?: ReactNode;
  active: boolean;
  onNavigate?: () => void;
  count?: number;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
        active
          ? "bg-[var(--color-primary-tint)] font-medium text-[var(--color-primary)]"
          : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
      }`}
    >
      {icon ? (
        <span className={active ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"}>{icon}</span>
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-[var(--color-primary)]" : "bg-[var(--color-rule-strong)]"}`} />
      )}
      <span className="flex-1">{label}</span>
      {count && count > 0 ? (
        <span className="tnum inline-flex min-w-[1.5rem] justify-center rounded-full bg-[var(--color-warn-soft)] px-1.5 py-0.5 text-[0.65rem] font-semibold text-[var(--color-warn)]">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}

function NavLinks({
  pathname,
  onNavigate,
  reviewCount,
  role,
  canSeeTransactions,
}: {
  pathname: string;
  onNavigate?: () => void;
  reviewCount: number;
  role: string;
  canSeeTransactions: boolean;
}) {
  // A viewer sees only their people and (if permitted) the ledger; managers and
  // admins see the analysis and admin drawers. Server-side guards enforce this
  // regardless — hiding the links just keeps a scoped user from bumping into doors.
  const isManager = role === "manager" || role === "admin";
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const financialActive = isActive("/calculations") || isActive("/projections");
  const individualsActive = isActive("/individuals") || isActive("/people");
  const employeesActive = isActive("/employees");
  const homeActive = isActive("/home") || isActive("/dashboard");

  return (
    <nav aria-label="Primary" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {/* Home — the management overview, managers and admins only */}
      {isManager ? (
        <div>
          <ul className="space-y-0.5">
            <li>
              <QuietLink
                href="/home"
                label="Home"
                icon={<HomeIcon />}
                active={homeActive}
                onNavigate={onNavigate}
              />
            </li>
          </ul>
        </div>
      ) : null}

      {/* The daily workspaces — the ledger and the two people views it feeds */}
      <div>
        <p className="eyebrow px-2 pb-1.5">Workspaces</p>
        <div className="space-y-2">
          {canSeeTransactions ? (
            <PrimaryTile
              href="/transactions"
              label="Transactions"
              sub="What was actually billed — the source of truth"
              icon={<TransactionsIcon />}
              active={isActive("/transactions")}
              onNavigate={onNavigate}
            />
          ) : null}
          <PrimaryTile
            href="/individuals"
            label="Individuals"
            sub="Budgets, usage & people, per individual"
            icon={<PeopleIcon />}
            active={individualsActive}
            onNavigate={onNavigate}
          />
          <PrimaryTile
            href="/employees"
            label="Employees"
            sub="Each worker's activity, from the ledger"
            icon={<PeopleIcon />}
            active={employeesActive}
            onNavigate={onNavigate}
          />
        </div>
      </div>

      {/* Analysis: budgets planning, money and everything you sometimes need.
          Manager+ only — a scoped viewer sees per-individual financials on the
          individual page, not the portfolio-wide analysis screens. */}
      {isManager ? (
        <div>
          <p className="eyebrow px-2 pb-1.5">Analysis</p>
          <ul className="space-y-0.5">
            <li>
              <QuietLink
                href="/calculations"
                label="Financial"
                icon={<ProjectionsIcon />}
                active={financialActive}
                onNavigate={onNavigate}
              />
            </li>
            <li>
              <QuietLink
                href="/masser"
                label="Masser board"
                icon={<MasserIcon />}
                active={isActive("/masser")}
                onNavigate={onNavigate}
              />
            </li>
            <li>
              <QuietLink
                href="/reports"
                label="Reports"
                icon={<ReportsIcon />}
                active={isActive("/reports")}
                onNavigate={onNavigate}
              />
            </li>
            <li>
              <QuietLink
                href="/schedule"
                label="Schedule"
                icon={<CalendarIcon />}
                active={isActive("/schedule")}
                onNavigate={onNavigate}
              />
            </li>
            <li>
              <QuietLink
                href="/review"
                label="Review"
                icon={<InboxIcon />}
                active={isActive("/review")}
                onNavigate={onNavigate}
                count={reviewCount}
              />
            </li>
          </ul>
        </div>
      ) : null}

      {/* Admin — the drawer everyone rarely opens. A viewer only ever sees
          Settings here (to change their own password); the ops tools are manager+. */}
      <div className="space-y-1.5 border-t border-[var(--color-rule)] pt-4">
        <p className="eyebrow px-2 pb-1">{isManager ? "Admin" : "Account"}</p>
        <ul className="space-y-0.5">
          {ADMIN_ITEMS.filter((item) => item.href === "/settings" || isManager).map((item) => (
            <li key={item.href}>
              <QuietLink
                href={item.href}
                label={item.href === "/settings" && !isManager ? "Settings & password" : item.label}
                icon={item.href === "/settings" ? <CogIcon /> : undefined}
                active={isActive(item.href)}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function UserFooter({ user }: { user: AuthenticatedUser }) {
  return (
    <div className="border-t border-[var(--color-rule)] px-4 py-3">
      <div className="mb-2 min-w-0">
        <p className="truncate text-sm font-medium text-[var(--color-ink)]">{user.displayName}</p>
        <p className="text-xs text-[var(--color-ink-faint)]">{ROLE_LABEL[user.role] ?? user.role}</p>
      </div>
      <form method="post" action="/api/auth/logout">
        <button type="submit" className="btn btn-sm btn-secondary w-full">
          Sign out
        </button>
      </form>
    </div>
  );
}

export default function AppNav({
  user,
  reviewCount = 0,
  canSeeTransactions = true,
}: {
  user: AuthenticatedUser;
  reviewCount?: number;
  canSeeTransactions?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-[var(--color-primary)] focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <CommandBar role={user.role} canSeeTransactions={canSeeTransactions} />

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-2.5 md:hidden">
        <Wordmark />
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          aria-expanded={open}
          aria-controls="app-sidebar"
          onClick={() => setOpen((v) => !v)}
        >
          Menu
        </button>
      </header>

      {/* Backdrop for mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setOpen(false)} aria-hidden />
      )}

      {/* Sidebar (desktop) / drawer (mobile) */}
      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-[var(--color-rule)] bg-[var(--color-surface)] transition-transform md:sticky md:top-0 md:z-0 md:h-screen md:translate-x-0 ${
          open ? "translate-x-0 shadow-lg" : "-translate-x-full"
        }`}
      >
        <div className="hidden flex-col gap-3 px-5 py-4 md:flex">
          <Wordmark />
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("open-command-bar"))}
            className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-xs text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-ink)]"
          >
            <span>Go to…</span>
            <kbd className="rounded border border-[var(--color-rule-strong)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[0.65rem] font-medium">⌘K</kbd>
          </button>
        </div>
        <div className="flex items-center justify-between px-5 py-4 md:hidden">
          <Wordmark />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} aria-label="Close menu">
            ✕
          </button>
        </div>
        <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} reviewCount={reviewCount} role={user.role} canSeeTransactions={canSeeTransactions} />
        <UserFooter user={user} />
      </aside>
    </>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AuthenticatedUser } from "@/lib/auth/session";

type NavItem = { href: string; label: string };
type NavGroup = { heading: string; items: NavItem[] };

// The two spreadsheet workspaces lead the whole product; everything else is a
// quieter "supporting" region grouped under clear headings.
const SUPPORTING: NavGroup[] = [
  {
    heading: "Operations",
    items: [
      { href: "/sync", label: "Sheet sync" },
      { href: "/schedule", label: "Schedule" },
      { href: "/imports", label: "Imports (backup)" },
      { href: "/reconciliation", label: "Reconciliation" },
    ],
  },
  {
    heading: "People",
    items: [
      { href: "/individuals", label: "Individuals" },
      { href: "/employees", label: "Employees" },
      { href: "/matches", label: "Name matches" },
    ],
  },
  {
    heading: "Insight & admin",
    items: [
      { href: "/reports", label: "Reports" },
      { href: "/exceptions", label: "Exceptions" },
      { href: "/aliases", label: "Aliases" },
      { href: "/settings", label: "Settings" },
    ],
  },
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

function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

function Wordmark() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5">
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

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const projectionsActive = isActive("/calculations") || isActive("/projections");

  return (
    <nav aria-label="Primary" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {/* The two dominant workspaces */}
      <div>
        <p className="eyebrow px-2 pb-1.5">Workspaces</p>
        <div className="space-y-2">
          <PrimaryTile
            href="/transactions"
            label="Transactions"
            sub="What was actually billed"
            icon={<TransactionsIcon />}
            active={isActive("/transactions")}
            onNavigate={onNavigate}
          />
          <PrimaryTile
            href="/calculations"
            label="Projections"
            sub="Budgets, pacing & utilization"
            icon={<ProjectionsIcon />}
            active={projectionsActive}
            onNavigate={onNavigate}
          />
        </div>
      </div>

      {/* Overview */}
      <div>
        <ul className="space-y-0.5">
          <li>
            <Link
              href="/dashboard"
              onClick={onNavigate}
              aria-current={isActive("/dashboard") ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                isActive("/dashboard")
                  ? "bg-[var(--color-primary-tint)] font-medium text-[var(--color-primary)]"
                  : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
              }`}
            >
              <span className={isActive("/dashboard") ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"}>
                <DashboardIcon />
              </span>
              Dashboard
            </Link>
          </li>
        </ul>
      </div>

      {/* Supporting screens */}
      <div className="space-y-5 border-t border-[var(--color-rule)] pt-4">
        <p className="eyebrow px-2 -mb-2">Supporting</p>
        {SUPPORTING.map((group) => (
          <div key={group.heading}>
            <p className="eyebrow px-2 pb-1.5 text-[0.625rem] opacity-80">{group.heading}</p>
            <ul className="space-y-0.5">
              {group.items.map((link) => {
                const active = isActive(link.href);
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                        active
                          ? "bg-[var(--color-primary-tint)] font-medium text-[var(--color-primary)]"
                          : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${active ? "bg-[var(--color-primary)]" : "bg-[var(--color-rule-strong)]"}`}
                      />
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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

export default function AppNav({ user }: { user: AuthenticatedUser }) {
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
        <div className="hidden items-center px-5 py-4 md:flex">
          <Wordmark />
        </div>
        <div className="flex items-center justify-between px-5 py-4 md:hidden">
          <Wordmark />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} aria-label="Close menu">
            ✕
          </button>
        </div>
        <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
        <UserFooter user={user} />
      </aside>
    </>
  );
}

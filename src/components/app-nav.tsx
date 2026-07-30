"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { AuthenticatedUser } from "@/lib/auth/session";

type NavItem = { href: string; label: string };
type NavGroup = { heading: string; items: NavItem[] };

// Grouped so the two spreadsheet workspaces lead and support screens are tucked
// under clear headings rather than crammed into one long bar.
const GROUPS: NavGroup[] = [
  {
    heading: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/transactions", label: "Transactions" },
      { href: "/calculations", label: "Calculations" },
    ],
  },
  {
    heading: "Operations",
    items: [
      { href: "/schedule", label: "Schedule" },
      { href: "/imports", label: "Imports" },
      { href: "/reconciliation", label: "Reconciliation" },
    ],
  },
  {
    heading: "People",
    items: [
      { href: "/individuals", label: "Individuals" },
      { href: "/employees", label: "Employees" },
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

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {GROUPS.map((group) => (
        <div key={group.heading}>
          <p className="eyebrow px-2 pb-1.5">{group.heading}</p>
          <ul className="space-y-0.5">
            {group.items.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
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

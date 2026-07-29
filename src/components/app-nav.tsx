"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { AuthenticatedUser } from "@/lib/auth/session";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/imports", label: "Imports" },
  { href: "/individuals", label: "Individuals" },
  { href: "/employees", label: "Employees" },
  { href: "/schedule", label: "Schedule" },
  { href: "/transactions", label: "Transactions" },
  { href: "/exceptions", label: "Exceptions" },
  { href: "/aliases", label: "Aliases" },
  { href: "/reports", label: "Reports" },
  { href: "/settings", label: "Settings" },
];

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator",
  manager: "Manager",
  viewer: "Viewer",
};

export default function AppNav({ user }: { user: AuthenticatedUser }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="border-b border-[var(--color-rule)] bg-[var(--color-surface)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-[var(--color-primary)] focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/dashboard" className="display text-base font-medium">
          Ahivim
          <span className="ml-2 text-xs font-normal text-[var(--color-ink-faint)]">
            Budget Management
          </span>
        </Link>

        <button
          type="button"
          className="ml-auto rounded border border-[var(--color-rule-strong)] px-2 py-1 text-xs md:hidden"
          aria-expanded={open}
          aria-controls="primary-navigation"
          onClick={() => setOpen((v) => !v)}
        >
          Menu
        </button>

        <nav
          id="primary-navigation"
          aria-label="Primary"
          className={`${open ? "block" : "hidden"} w-full md:block md:w-auto`}
        >
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {LINKS.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={
                      active
                        ? "border-b-2 border-[var(--color-primary)] pb-0.5 font-medium text-[var(--color-primary)]"
                        : "pb-0.5 text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                    }
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto hidden items-center gap-3 text-xs text-[var(--color-ink-faint)] md:flex">
          <span>
            {user.displayName}
            <span className="ml-1">({ROLE_LABEL[user.role] ?? user.role})</span>
          </span>
          <form method="post" action="/api/auth/logout">
            <button
              type="submit"
              className="rounded border border-[var(--color-rule-strong)] px-2 py-1 text-[var(--color-ink)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

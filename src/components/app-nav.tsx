"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BadgeDollarSign,
  BarChart3,
  ChevronDown,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings2,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AuthenticatedUser } from "@/lib/auth/session";
import {
  destinationIsActive,
  getVisibleAdminDestinations,
  getVisibleWorkspaces,
  workspaceIsActive,
  type NavigationAccess,
  type VisibleNavigationWorkspace,
} from "@/lib/nav/app-navigation";
import CommandBar from "@/components/command-bar";

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator",
  manager: "Manager",
  viewer: "Viewer",
};

const WORKSPACE_ICONS: Record<VisibleNavigationWorkspace["id"], LucideIcon> = {
  overview: LayoutDashboard,
  budgets: WalletCards,
  payroll: BadgeDollarSign,
  activity: Activity,
  review: Inbox,
  reports: BarChart3,
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function Wordmark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/home" onClick={onNavigate} className="flex min-w-0 items-center gap-2.5 rounded-md outline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary)] text-sm font-bold text-white">A</span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold text-[var(--color-ink)]">Ahivim</span>
        <span className="block truncate text-[0.65rem] text-[var(--color-ink-faint)]">Budget Management</span>
      </span>
    </Link>
  );
}

function WorkspaceNavigation({
  pathname,
  access,
  reviewCount,
  onNavigate,
}: {
  pathname: string;
  access: NavigationAccess;
  reviewCount: number;
  onNavigate?: () => void;
}) {
  const workspaces = useMemo(() => getVisibleWorkspaces(access), [access]);

  return (
    <div>
      <p className="eyebrow px-3 pb-2">Work</p>
      <ul className="space-y-1">
        {workspaces.map((workspace) => {
          const active = workspaceIsActive(pathname, workspace);
          const landingActive = destinationIsActive(pathname, workspace.destinations[0]);
          const Icon = WORKSPACE_ICONS[workspace.id];
          const secondary = workspace.destinations.filter((destination) => destination.href !== workspace.href);

          return (
            <li key={workspace.id}>
              <Link
                href={workspace.href}
                onClick={onNavigate}
                aria-current={landingActive ? "page" : undefined}
                title={workspace.hint}
                className={`flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-[var(--color-primary-tint)] font-semibold text-[var(--color-primary)]"
                    : "font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                }`}
              >
                <Icon className={`h-[1.1rem] w-[1.1rem] shrink-0 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
                {workspace.id === "review" && reviewCount > 0 ? (
                  <span className="tnum inline-flex min-w-6 justify-center rounded-full bg-[var(--color-warn-soft)] px-1.5 py-0.5 text-[0.65rem] font-semibold text-[var(--color-warn)]">
                    {reviewCount > 99 ? "99+" : reviewCount}
                  </span>
                ) : null}
              </Link>

              {active && secondary.length > 0 ? (
                <ul className="ml-[1.8rem] mt-1 space-y-0.5 border-l border-[var(--color-rule-strong)] pl-3">
                  {secondary.map((destination) => {
                    const childActive = destinationIsActive(pathname, destination);
                    return (
                      <li key={destination.id}>
                        <Link
                          href={destination.href}
                          onClick={onNavigate}
                          aria-current={childActive ? "page" : undefined}
                          title={destination.hint}
                          className={`block rounded-md px-2 py-1.5 text-xs transition-colors ${
                            childActive
                              ? "font-semibold text-[var(--color-primary)]"
                              : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                          }`}
                        >
                          {destination.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AdministrationNavigation({
  pathname,
  access,
  onNavigate,
  controlId,
}: {
  pathname: string;
  access: NavigationAccess;
  onNavigate?: () => void;
  controlId: string;
}) {
  const items = useMemo(() => getVisibleAdminDestinations(access), [access]);
  const active = items.some((item) => destinationIsActive(pathname, item));
  const [open, setOpen] = useState(active);
  const isManager = access.role === "manager" || access.role === "admin";

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  return (
    <div className="border-t border-[var(--color-rule)] pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlId}
        onClick={() => setOpen((value) => !value)}
        className={`flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
          active
            ? "bg-[var(--color-primary-tint)] font-semibold text-[var(--color-primary)]"
            : "font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
        }`}
      >
        <Settings2 className={`h-[1.1rem] w-[1.1rem] shrink-0 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{isManager ? "Administration" : "Account"}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      <ul id={controlId} hidden={!open} className="ml-[1.8rem] mt-1 space-y-0.5 border-l border-[var(--color-rule-strong)] pl-3">
        {items.map((item) => {
          const itemActive = destinationIsActive(pathname, item);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={itemActive ? "page" : undefined}
                title={item.hint}
                className={`block rounded-md px-2 py-1.5 text-xs transition-colors ${
                  itemActive
                    ? "font-semibold text-[var(--color-primary)]"
                    : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
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
        <button type="submit" className="btn btn-sm btn-secondary flex w-full items-center justify-center gap-2">
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </form>
    </div>
  );
}

function SidebarBody({
  user,
  pathname,
  access,
  reviewCount,
  onNavigate,
  adminControlId,
}: {
  user: AuthenticatedUser;
  pathname: string;
  access: NavigationAccess;
  reviewCount: number;
  onNavigate?: () => void;
  adminControlId: string;
}) {
  return (
    <>
      <nav aria-label="Primary" className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        <WorkspaceNavigation pathname={pathname} access={access} reviewCount={reviewCount} onNavigate={onNavigate} />
        <AdministrationNavigation pathname={pathname} access={access} onNavigate={onNavigate} controlId={adminControlId} />
      </nav>
      <UserFooter user={user} />
    </>
  );
}

export default function AppNav({
  user,
  reviewCount = 0,
  accessResolved = false,
  canSeeTransactions = false,
  canSeeSettlements = false,
  canSeeBudgets = false,
  canPlan = false,
}: {
  user: AuthenticatedUser;
  reviewCount?: number;
  accessResolved?: boolean;
  canSeeTransactions?: boolean;
  canSeeSettlements?: boolean;
  canSeeBudgets?: boolean;
  canPlan?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const access = useMemo<NavigationAccess>(
    () => ({ role: user.role, accessResolved, canSeeTransactions, canSeeSettlements, canSeeBudgets, canPlan }),
    [user.role, accessResolved, canSeeTransactions, canSeeSettlements, canSeeBudgets, canPlan],
  );

  const closeDrawer = useCallback(() => setOpen(false), []);
  const openDrawer = useCallback(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : menuButtonRef.current;
    setOpen(true);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    media.addEventListener("change", closeAtDesktop);
    return () => media.removeEventListener("change", closeAtDesktop);
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;

      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => previousFocusRef.current?.focus());
    };
  }, [open, closeDrawer]);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded focus:bg-[var(--color-primary)] focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <CommandBar role={user.role} accessResolved={accessResolved} canSeeTransactions={canSeeTransactions} canSeeSettlements={canSeeSettlements} canSeeBudgets={canSeeBudgets} canPlan={canPlan} />

      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-2.5 md:hidden">
        <Wordmark />
        <button
          ref={menuButtonRef}
          type="button"
          aria-expanded={open}
          aria-controls="mobile-app-sidebar"
          aria-label="Open navigation"
          title="Open navigation"
          onClick={openDrawer}
          className="btn btn-sm btn-secondary grid h-9 w-9 place-items-center p-0"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </header>

      {open ? <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={closeDrawer} aria-hidden /> : null}

      <aside
        ref={drawerRef}
        id="mobile-app-sidebar"
        role="dialog"
        aria-modal={open ? "true" : undefined}
        aria-label="Main navigation"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(20rem,calc(100vw-2rem))] flex-col border-r border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xl transition-transform md:hidden ${
          open ? "translate-x-0" : "pointer-events-none -translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <Wordmark onNavigate={closeDrawer} />
          <button
            ref={closeButtonRef}
            type="button"
            className="btn btn-sm btn-ghost grid h-9 w-9 place-items-center p-0"
            onClick={closeDrawer}
            aria-label="Close navigation"
            title="Close navigation"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <SidebarBody
          user={user}
          pathname={pathname}
          access={access}
          reviewCount={reviewCount}
          onNavigate={closeDrawer}
          adminControlId="mobile-administration-links"
        />
      </aside>

      <aside className="hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--color-rule)] bg-[var(--color-surface)] md:sticky md:top-0 md:flex">
        <div className="flex flex-col gap-3 px-5 py-4">
          <Wordmark />
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("open-command-bar"))}
            className="flex min-h-9 items-center gap-2 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-ink)]"
          >
            <Search className="h-4 w-4" aria-hidden />
            <span>Search</span>
          </button>
        </div>
        <SidebarBody
          user={user}
          pathname={pathname}
          access={access}
          reviewCount={reviewCount}
          adminControlId="desktop-administration-links"
        />
      </aside>
    </>
  );
}

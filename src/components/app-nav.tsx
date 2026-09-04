"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AuthenticatedUser } from "@/lib/auth/session";
import {
  destinationIsActive,
  getVisibleAdminDestinations,
  getVisibleWorkspaces,
  shouldTrackNavigation,
  workspaceIsActive,
  type NavigationAccess,
  type VisibleNavigationWorkspace,
} from "@/lib/nav/app-navigation";
import CommandBar from "@/components/command-bar";

const WORKSPACE_ICONS: Record<VisibleNavigationWorkspace["id"], LucideIcon> = {
  overview: LayoutDashboard,
  portal: ShieldCheck,
  people: Users,
  activity: CalendarDays,
  money: WalletCards,
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function Wordmark({ onNavigate }: { onNavigate?: (href: string) => void }) {
  return (
    <Link href="/home" onNavigate={() => onNavigate?.("/home")} className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-md outline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary)] text-sm font-bold text-white">A</span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold text-[var(--color-ink)]">Ahivim</span>
        <span className="block truncate text-[0.65rem] text-[var(--color-ink-faint)]">Operations</span>
      </span>
    </Link>
  );
}

function WorkspaceNavigation({
  pathname,
  access,
  onNavigate,
}: {
  pathname: string;
  access: NavigationAccess;
  onNavigate?: (href: string) => void;
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
          const activeSecondaryId = secondary
            .filter((destination) => destinationIsActive(pathname, destination))
            .sort((left, right) => right.href.length - left.href.length)[0]?.id;

          return (
            <li key={workspace.id}>
              <Link
                href={workspace.href}
                onNavigate={() => onNavigate?.(workspace.href)}
                aria-current={landingActive ? "page" : undefined}
                title={workspace.hint}
                className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-[var(--color-primary-tint)] font-semibold text-[var(--color-primary)]"
                    : "font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                }`}
              >
                <Icon className={`h-[1.1rem] w-[1.1rem] shrink-0 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
              </Link>

              {active && secondary.length > 0 ? (
                <ul className="ml-[1.8rem] mt-1 space-y-0.5 border-l border-[var(--color-rule-strong)] pl-3">
                  {secondary.map((destination) => {
                    const childActive = destination.id === activeSecondaryId;
                    return (
                      <li key={destination.id}>
                        <Link
                          href={destination.href}
                          onNavigate={() => onNavigate?.(destination.href)}
                          aria-current={childActive ? "page" : undefined}
                          title={destination.hint}
                          className={`flex min-h-11 items-center rounded-md px-2 py-1.5 text-xs transition-colors ${
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
  onNavigate?: (href: string) => void;
  controlId: string;
}) {
  const items = useMemo(() => getVisibleAdminDestinations(access), [access]);
  const activeItemId = items
    .filter((item) => destinationIsActive(pathname, item))
    .sort((left, right) => right.href.length - left.href.length)[0]?.id;
  const active = Boolean(activeItemId);
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
        className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
          active
            ? "bg-[var(--color-primary-tint)] font-semibold text-[var(--color-primary)]"
            : "font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
        }`}
      >
        <Settings2 className={`h-[1.1rem] w-[1.1rem] shrink-0 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)]"}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{isManager ? "Settings" : "Account"}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      <ul id={controlId} hidden={!open} className="ml-[1.8rem] mt-1 space-y-0.5 border-l border-[var(--color-rule-strong)] pl-3">
        {items.map((item) => {
          const itemActive = item.id === activeItemId;
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                onNavigate={() => onNavigate?.(item.href)}
                aria-current={itemActive ? "page" : undefined}
                title={item.hint}
                className={`flex min-h-11 items-center rounded-md px-2 py-1.5 text-xs transition-colors ${
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

function UserFooter({ user, accountLabel }: { user: AuthenticatedUser; accountLabel: string }) {
  return (
    <div className="border-t border-[var(--color-rule)] px-4 py-3">
      <div className="mb-2 min-w-0">
        <p className="truncate text-sm font-medium text-[var(--color-ink)]">{user.displayName}</p>
        <p className="text-xs text-[var(--color-ink-faint)]">{accountLabel}</p>
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
  accountLabel,
  onNavigate,
  adminControlId,
}: {
  user: AuthenticatedUser;
  pathname: string;
  access: NavigationAccess;
  accountLabel: string;
  onNavigate?: (href: string) => void;
  adminControlId: string;
}) {
  return (
    <>
      <nav aria-label="Primary" className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        <WorkspaceNavigation pathname={pathname} access={access} onNavigate={onNavigate} />
        <AdministrationNavigation pathname={pathname} access={access} onNavigate={onNavigate} controlId={adminControlId} />
      </nav>
      <UserFooter user={user} accountLabel={accountLabel} />
    </>
  );
}

export default function AppNav({
  user,
  accountLabel,
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
  user: AuthenticatedUser;
  accountLabel: string;
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
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locationKey = `${pathname}?${searchParams.toString()}`;
  const [open, setOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const access = useMemo<NavigationAccess>(
    () => ({ role: user.role, accountPreset: user.accountPreset, accessResolved, canSeeTransactions, canSeeSettlements, canSeeBudgets, canPlan, canSeeClassFinancials, canSeeEmployees, canEditDocuments, canUsePortal, canManageAgencies }),
    [user.role, user.accountPreset, accessResolved, canSeeTransactions, canSeeSettlements, canSeeBudgets, canPlan, canSeeClassFinancials, canSeeEmployees, canEditDocuments, canUsePortal, canManageAgencies],
  );

  const closeDrawer = useCallback(() => setOpen(false), []);
  const beginNavigation = useCallback((href: string) => {
    closeDrawer();
    if (shouldTrackNavigation(pathname, href)) setPendingHref(href);
  }, [closeDrawer, pathname]);
  const openDrawer = useCallback(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : menuButtonRef.current;
    setOpen(true);
  }, []);

  useEffect(() => {
    setOpen(false);
    setPendingHref(null);
  }, [locationKey]);

  useEffect(() => {
    const trackInternalLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const element = event.target instanceof Element ? event.target : null;
      const link = element?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;

      const destination = new URL(link.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      const sameDocument = destination.pathname === window.location.pathname
        && destination.search === window.location.search;
      if (sameDocument) return;

      setPendingHref(`${destination.pathname}${destination.search}`);
    };

    const trackInternalForm = (event: SubmitEvent) => {
      // Client-managed forms prevent the native submit and already show their
      // own busy state. Only show route progress for a real page submission.
      if (event.defaultPrevented) return;
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (!form || form.target === "_blank") return;

      const submitter = event.submitter instanceof HTMLButtonElement
        || event.submitter instanceof HTMLInputElement
        ? event.submitter
        : null;
      const action = submitter?.formAction || form.action || window.location.href;
      const destination = new URL(action, window.location.href);
      if (destination.origin !== window.location.origin) return;

      setPendingHref(`${destination.pathname}${destination.search}`);
    };

    // Capture the intent before Next.js handles the link so content links and
    // table actions receive the same immediate feedback as sidebar links.
    document.addEventListener("click", trackInternalLink, true);
    // Submit is intentionally observed in the bubble phase so a client form's
    // preventDefault runs before we decide whether a page is navigating.
    document.addEventListener("submit", trackInternalForm);
    return () => {
      document.removeEventListener("click", trackInternalLink, true);
      document.removeEventListener("submit", trackInternalForm);
    };
  }, []);

  useEffect(() => {
    if (!pendingHref) return;
    const timeout = window.setTimeout(() => setPendingHref(null), 15_000);
    return () => window.clearTimeout(timeout);
  }, [pendingHref]);

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

      <CommandBar role={user.role} accountPreset={user.accountPreset} accessResolved={accessResolved} canSeeTransactions={canSeeTransactions} canSeeSettlements={canSeeSettlements} canSeeBudgets={canSeeBudgets} canPlan={canPlan} canSeeClassFinancials={canSeeClassFinancials} canSeeEmployees={canSeeEmployees} canEditDocuments={canEditDocuments} canUsePortal={canUsePortal} canManageAgencies={canManageAgencies} onNavigate={beginNavigation} />

      {pendingHref ? (
        <div className="pointer-events-none fixed inset-x-0 top-[var(--impersonation-bar-height)] z-[80] h-1 overflow-hidden bg-[var(--color-primary-soft)]" role="progressbar" aria-label="Loading page">
          <span className="route-progress-bar block h-full bg-[var(--color-primary)]" />
        </div>
      ) : null}

      <header className="sticky top-[var(--impersonation-bar-height)] z-30 flex items-center justify-between border-b border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-2.5 md:hidden">
        <Wordmark onNavigate={beginNavigation} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Search"
            title="Search"
            onClick={() => window.dispatchEvent(new Event("open-command-bar"))}
            className="btn btn-sm btn-icon btn-secondary"
          >
            <Search className="h-5 w-5" aria-hidden />
          </button>
          <button
            ref={menuButtonRef}
            type="button"
            aria-expanded={open}
            aria-controls="mobile-app-sidebar"
            aria-label="Open navigation"
            title="Open navigation"
            onClick={openDrawer}
            className="btn btn-sm btn-icon btn-secondary"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </header>

      {open ? <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onPointerDown={closeDrawer} aria-hidden /> : null}

      <aside
        ref={drawerRef}
        id="mobile-app-sidebar"
        role="dialog"
        aria-modal={open ? "true" : undefined}
        aria-label="Main navigation"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        className={`fixed bottom-0 left-0 top-[var(--impersonation-bar-height)] z-40 flex w-[min(20rem,calc(100vw-2rem))] flex-col border-r border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xl transition-transform md:hidden ${
          open ? "translate-x-0" : "pointer-events-none -translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <Wordmark onNavigate={beginNavigation} />
          <button
            ref={closeButtonRef}
            type="button"
            className="btn btn-sm btn-icon btn-ghost"
            onClick={closeDrawer}
            aria-label="Close navigation"
            title="Close navigation"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <SidebarBody
          user={user}
          accountLabel={accountLabel}
          pathname={pathname}
          access={access}
          onNavigate={beginNavigation}
          adminControlId="mobile-administration-links"
        />
      </aside>

      <aside className="hidden h-[calc(100vh-var(--impersonation-bar-height))] w-64 shrink-0 flex-col border-r border-[var(--color-rule)] bg-[var(--color-surface)] md:sticky md:top-[var(--impersonation-bar-height)] md:flex">
        <div className="flex flex-col gap-3 px-5 py-4">
          <Wordmark onNavigate={beginNavigation} />
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("open-command-bar"))}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-ink)]"
          >
            <Search className="h-4 w-4" aria-hidden />
            <span>Search</span>
          </button>
        </div>
        <SidebarBody
          user={user}
          accountLabel={accountLabel}
          pathname={pathname}
          access={access}
          onNavigate={beginNavigation}
          adminControlId="desktop-administration-links"
        />
      </aside>
    </>
  );
}

"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/**
 * Interactive primitives (client-only): accessible Tabs, a server-composable
 * TabPanels, and a modal Dialog. Kept separate from ui.tsx so the
 * server-rendered pieces there never pull in a client boundary.
 */

export type TabDef = { id: string; label: string; badge?: ReactNode };

function validTabId(tabs: TabDef[], id: string | undefined): string | undefined {
  return id && tabs.some((tab) => tab.id === id) ? id : undefined;
}

function TabList({
  tabs,
  active,
  onSelect,
  baseId,
  label = "Views",
}: {
  tabs: TabDef[];
  active: string;
  onSelect: (id: string) => void;
  baseId: string;
  label?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (!tab) return;
    onSelect(tab.id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className="scroll-thin flex gap-1 overflow-x-auto border-b border-[var(--color-rule)]"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === active;
        return (
          <button
            ref={(node) => { refs.current[index] = node; }}
            key={tab.id}
            id={`${baseId}-tab-${index}`}
            type="button"
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-controls={`${baseId}-panel-${index}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => move(event, index)}
            className={`relative -mb-px flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-sm font-semibold transition-colors ${
              isActive
                ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                : "border-transparent text-[var(--color-ink-soft)] hover:border-[var(--color-rule-strong)] hover:text-[var(--color-ink)]"
            }`}
          >
            {tab.label}
            {tab.badge != null ? (
              <span className={`tnum rounded-full px-1.5 py-0.5 text-xs ${isActive ? "bg-[var(--color-primary-tint)] text-[var(--color-primary)]" : "bg-[var(--color-surface-strong)] text-[var(--color-ink-soft)]"}`}>
                {tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs({
  tabs,
  initialId,
  onChange,
  children,
}: {
  tabs: TabDef[];
  initialId?: string;
  onChange?: (id: string) => void;
  children?: (activeId: string) => ReactNode;
}) {
  const [active, setActive] = useState<string>(initialId ?? tabs[0]?.id ?? "");
  const baseId = useId();

  useEffect(() => {
    if (initialId && tabs.some((tab) => tab.id === initialId)) setActive(initialId);
  }, [initialId, tabs]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === active)) setActive(tabs[0]?.id ?? "");
  }, [active, tabs]);

  const select = (id: string) => {
    setActive(id);
    onChange?.(id);
  };

  return (
    <div>
      <TabList tabs={tabs} active={active} onSelect={select} baseId={baseId} />
      {children ? (
        <div
          id={`${baseId}-panel-${Math.max(0, tabs.findIndex((tab) => tab.id === active))}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${Math.max(0, tabs.findIndex((tab) => tab.id === active))}`}
          tabIndex={0}
          className="pt-4 outline-none"
        >
          {children(active)}
        </div>
      ) : null}
    </div>
  );
}

export type TabPanel = { id: string; label: string; badge?: ReactNode; content: ReactNode };

/**
 * Tabs whose panels are pre-rendered (server components allowed). All panel
 * content is sent once and toggled client-side — one unified workspace instead
 * of a long scroll, with no extra round-trips.
 */
export function TabPanels({
  panels,
  initialId,
  paramKey,
}: {
  panels: TabPanel[];
  initialId?: string;
  /** When set, the active tab is mirrored into this URL search param so the view
   *  is linkable and survives a refresh. We use history.replaceState to avoid a
   *  server round-trip on force-dynamic pages. */
  paramKey?: string;
}) {
  const [active, setActive] = useState<string>(validTabId(panels, initialId) ?? panels[0]?.id ?? "");
  const current = panels.find((p) => p.id === active) ?? panels[0];
  const baseId = useId();
  const panelIdKey = panels.map((panel) => panel.id).join("\u0000");
  const previousInitialId = useRef(initialId);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(active ? [active] : []));

  useEffect(() => {
    const panelIds = panelIdKey ? panelIdKey.split("\u0000") : [];
    const next = initialId && panelIds.includes(initialId) ? initialId : undefined;
    const initialIdChanged = previousInitialId.current !== initialId;
    previousInitialId.current = initialId;
    setActive((currentId) => {
      if (initialIdChanged && next) return next;
      return panelIds.includes(currentId) ? currentId : next ?? panelIds[0] ?? "";
    });
  }, [initialId, panelIdKey]);

  useEffect(() => {
    if (!active) return;
    setVisited((currentIds) => {
      if (currentIds.has(active)) return currentIds;
      const nextIds = new Set(currentIds);
      nextIds.add(active);
      return nextIds;
    });
  }, [active]);

  useEffect(() => {
    if (!paramKey) return;
    const onPopState = () => {
      const next = validTabId(panels, new URL(window.location.href).searchParams.get(paramKey) ?? undefined);
      if (next) setActive(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [panels, paramKey]);

  const select = (id: string) => {
    setActive(id);
    if (paramKey && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set(paramKey, id);
      window.history.replaceState(null, "", url.toString());
    }
  };
  return (
    <div>
      <TabList tabs={panels} active={current?.id ?? ""} onSelect={select} baseId={baseId} />
      {panels.map((panel, index) => (visited.has(panel.id) || panel.id === current?.id) ? (
        <div
          key={panel.id}
          id={`${baseId}-panel-${index}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${index}`}
          tabIndex={panel.id === current?.id ? 0 : -1}
          hidden={panel.id !== current?.id}
          className="pt-5 outline-none"
        >
          {panel.content}
        </div>
      ) : null)}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = panelRef.current?.querySelector<HTMLElement>("[autofocus]");
      const first = panelRef.current?.querySelector<HTMLElement>(focusableSelector);
      (preferred ?? first ?? panelRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [open]);

  if (!open) return null;

  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";

  return (
    <div
      className="overlay-in fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/45 p-0 sm:items-start sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Dialog"}
        tabIndex={-1}
        className={`card pop-in relative flex max-h-[calc(100dvh-1rem)] w-full flex-col rounded-b-none ${width} outline-none sm:mt-8 sm:max-h-[calc(100dvh-4rem)] sm:rounded-b-lg`}
      >
        {title ? (
          <header className="flex items-center justify-between gap-3 border-b border-[var(--color-rule)] px-5 py-3.5">
            <h2 id={titleId} className="display min-w-0 text-base font-semibold text-[var(--color-ink)]">{title}</h2>
            <button type="button" onClick={() => onCloseRef.current()} className="btn btn-sm btn-icon btn-ghost shrink-0" aria-label="Close dialog" title="Close">
              <X aria-hidden className="h-4 w-4" />
            </button>
          </header>
        ) : (
          <button type="button" onClick={() => onCloseRef.current()} className="btn btn-sm btn-icon btn-ghost absolute right-3 top-3 z-10" aria-label="Close dialog" title="Close">
            <X aria-hidden className="h-4 w-4" />
          </button>
        )}
        <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

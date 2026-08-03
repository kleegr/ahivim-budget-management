"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Interactive primitives (client-only): accessible Tabs and a modal Dialog.
 * Kept separate from ui.tsx so the server-rendered pieces there never pull in
 * a client boundary. These are the building blocks for the Individual
 * workspace tabs and for unifying the app's ad-hoc modals.
 */

export type TabDef = { id: string; label: string; badge?: ReactNode };

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

  const select = (id: string) => {
    setActive(id);
    onChange?.(id);
  };

  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--color-rule)]">
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => select(t.id)}
              className={`relative -mb-px flex items-center gap-1.5 rounded-t-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "border-b-2 border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
              }`}
            >
              {t.label}
              {t.badge != null ? (
                <span className="rounded-full bg-[var(--color-surface-strong)] px-1.5 text-xs text-[var(--color-ink-soft)]">
                  {t.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {children ? (
        <div role="tabpanel" className="pt-4">
          {children(active)}
        </div>
      ) : null}
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`card mt-8 w-full ${width} outline-none`}
      >
        {title ? (
          <header className="flex items-center justify-between gap-3 border-b border-[var(--color-rule)] px-5 py-3.5">
            <h2 className="display text-[0.95rem] font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="btn btn-sm btn-ghost" aria-label="Close">
              ✕
            </button>
          </header>
        ) : null}
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-rule)] px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

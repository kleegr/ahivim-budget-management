"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Explicit, deliberate sorting — a small caret on the header that opens a menu
 * (Sort A→Z / Z→A / Clear). Sorting is NEVER triggered by clicking the header
 * text; you have to choose it here, like Google Sheets. The menu is portaled with
 * fixed positioning so it escapes the grid's overflow and the sticky header.
 */
export default function SortMenu({
  label,
  dir,
  numeric,
  onSort,
}: {
  label: string;
  dir: "asc" | "desc" | null; // current sort direction for this column, if any
  numeric?: boolean;
  onSort: (dir: "asc" | "desc" | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const WIDTH = 168;

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const left = Math.max(8, Math.min(b.left, window.innerWidth - WIDTH - 8));
      setPos({ top: b.bottom + 4, left });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const asc = numeric ? "Sort smallest first" : "Sort A → Z";
  const desc = numeric ? "Sort largest first" : "Sort Z → A";
  const choose = (d: "asc" | "desc" | null) => { onSort(d); setOpen(false); };

  const Item = ({ d, children }: { d: "asc" | "desc" | null; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={() => choose(d)}
      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-strong)] ${dir === d ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-ink)]"}`}
    >
      {children}
      {dir === d ? <span aria-hidden>✓</span> : null}
    </button>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={`Sort ${label}`}
        aria-label={`Sort ${label}`}
        aria-expanded={open}
        className={`grid h-5 w-5 place-items-center rounded transition-colors ${
          dir ? "text-[var(--color-primary)]" : "text-[var(--color-ink-faint)] opacity-60 hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)] hover:opacity-100"
        }`}
      >
        <span aria-hidden className="text-[10px] leading-none">{dir === "asc" ? "▲" : dir === "desc" ? "▼" : "⇅"}</span>
      </button>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="pop-in fixed z-[70] origin-top rounded-xl border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-1 shadow-lg"
              style={{ top: pos.top, left: pos.left, width: WIDTH }}
              onClick={(e) => e.stopPropagation()}
            >
              <Item d="asc">{asc}</Item>
              <Item d="desc">{desc}</Item>
              {dir ? (
                <>
                  <div className="my-1 border-t border-[var(--color-rule)]" />
                  <Item d={null}>Clear sort</Item>
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Shared building blocks for the editable screens: a modal, labelled fields,
 * and two action primitives (a create form and an action button) that talk to
 * the REST API, surface the server's own error text, and refresh on success.
 * Every write goes through these, so the UX (confirm, reason, loading, error,
 * success) is uniform everywhere.
 */

async function send(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: unknown };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, error: "Could not reach the server. Your change was not saved." };
  }
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    document.body.style.overflow = "hidden";
    const initial = dialog?.querySelector<HTMLElement>(
      "[data-modal-initial], input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    (initial ?? dialog)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
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
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div ref={dialogRef} tabIndex={-1} className="mt-8 w-full max-w-lg rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xl outline-none">
        <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-5 py-3">
          <h2 id={titleId} className="display text-base font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn btn-sm btn-icon btn-ghost"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  placeholder,
  help,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  placeholder?: string;
  help?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue ?? undefined}
        step={type === "number" ? "any" : undefined}
        className="input mt-1 w-full"
      />
      {help ? <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">{help}</span> : null}
    </label>
  );
}

export function TextAreaField({
  label,
  name,
  defaultValue,
  placeholder,
  required,
  minLength,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <textarea
        name={name}
        rows={2}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        defaultValue={defaultValue ?? undefined}
        className="input mt-1 w-full py-2"
      />
    </label>
  );
}

export function SelectField({
  label,
  name,
  options,
  defaultValue,
  required,
  placeholder,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="select mt-1 w-full"
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A button that opens a modal form and submits it to an endpoint. */
export function CreateButton({
  label,
  title,
  endpoint,
  method = "POST",
  fields,
  hidden,
  transform,
  variant = "primary",
  size = "md",
  onDone,
}: {
  label: string;
  title: string;
  endpoint: string;
  method?: string;
  fields: ReactNode;
  hidden?: Record<string, string>;
  transform?: (form: Record<string, string>) => Record<string, unknown>;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  onDone?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body = transform ? transform(raw) : raw;
    setBusy(true);
    setError(null);
    const result = await send(method, endpoint, { ...hidden, ...body });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Save failed.");
      return;
    }
    setOpen(false);
    onDone?.();
    router.refresh();
  }

  return (
    <>
      <button type="button" className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""}`} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <Modal title={title} onClose={() => (busy ? null : setOpen(false))}>
          <form onSubmit={onSubmit} className="space-y-3">
            {error ? (
              <p role="alert" className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">
                {error}
              </p>
            ) : null}
            {fields}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary">
                Cancel
              </button>
              <button type="submit" disabled={busy} aria-busy={busy} className="btn btn-primary">
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * A one-click action (archive, restore, approve, cancel…). Confirms first, can
 * collect a reason, PATCHes/POSTs, and refreshes.
 */
export function ActionButton({
  label,
  endpoint,
  method = "PATCH",
  body,
  confirm,
  withReason,
  variant = "secondary",
  size = "sm",
}: {
  label: string;
  endpoint: string;
  method?: string;
  body?: Record<string, unknown>;
  confirm?: string;
  withReason?: boolean;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");

  async function run(auditReason?: string) {
    if (!withReason && confirm && !window.confirm(confirm)) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await send(method, endpoint, {
      ...body,
      ...(auditReason !== undefined ? { reason: auditReason } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Action failed.");
      return;
    }
    setReasonOpen(false);
    setReason("");
    router.refresh();
  }

  function requestAction() {
    setError(null);
    if (withReason) {
      setReasonOpen(true);
      return;
    }
    void run();
  }

  function submitReason(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = reason.trim();
    if (value.length < 5) {
      setError("Enter a reason of at least 5 characters for the audit history.");
      return;
    }
    void run(value);
  }

  return (
    <>
      <span className="inline-flex flex-col items-start gap-0.5">
        <button type="button" onClick={requestAction} disabled={busy} aria-busy={busy} className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""}`}>
          {busy ? "Working..." : label}
        </button>
        {!reasonOpen && error ? <span role="alert" className="text-xs text-[var(--color-pace-over)]">{error}</span> : null}
      </span>
      {reasonOpen ? (
        <Modal title={`${label} - reason`} onClose={() => (busy ? null : setReasonOpen(false))}>
          <form onSubmit={submitReason} className="space-y-3">
            <label className="block">
              <span className="text-sm font-medium">Reason for this change</span>
              <textarea
                data-modal-initial
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                minLength={5}
                required
                className="input mt-1 w-full py-2"
              />
              <span className="mt-1 block text-xs text-[var(--color-ink-faint)]">This will be recorded in the audit history.</span>
            </label>
            {error ? <p role="alert" className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setReasonOpen(false)} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={busy} aria-busy={busy} className="btn btn-primary">
                {busy ? "Working..." : label}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

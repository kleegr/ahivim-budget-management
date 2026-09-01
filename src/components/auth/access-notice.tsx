"use client";

import { ShieldAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";

export default function AccessNotice() {
  const denied = useSearchParams().get("denied") === "1";
  if (!denied) return null;

  return (
    <div
      role="alert"
      className="mb-5 flex items-start gap-2 border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2.5 text-sm text-[var(--color-ink)]"
    >
      <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />
      <p>
        That page is not included in this account. You are back in the workspace available to you.
      </p>
    </div>
  );
}

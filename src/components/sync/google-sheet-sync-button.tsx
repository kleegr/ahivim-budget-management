"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import Link from "next/link";
import { syncRoundTripOutcomePresentation } from "@/lib/nav/sync-actions";

type State = "idle" | "busy" | "done" | "failed";

export default function GoogleSheetSyncButton() {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [resultText, setResultText] = useState("");
  const [resultAction, setResultAction] = useState<{ href: string; label: string } | null>(null);

  async function sync() {
    if (state === "busy") return;
    setState("busy");
    setResultText("");
    setResultAction(null);
    try {
      const response = await fetch("/api/sync/run", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        summary?: { status?: unknown; error?: unknown; note?: unknown };
        writeback?: { status?: unknown; eligible?: unknown; updated?: unknown; skipped?: unknown; error?: unknown };
        error?: unknown;
      };
      if (!response.ok) {
        setState("failed");
        setResultText(typeof body.error === "string" && body.error.trim()
          ? body.error
          : "The Google Sheet could not be reached. Try again.");
        return;
      }

      const outcome = syncRoundTripOutcomePresentation(body);
      setState(outcome.tone === "ok" ? "done" : "failed");
      setResultText(outcome.message);
      setResultAction(outcome.action);
      // The pull can succeed even when a payment-marker write-back fails. In
      // that case the latest imported data must still appear immediately.
      router.refresh();
    } catch {
      setState("failed");
      setResultText("The Google Sheet could not be reached. Try again.");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        className="btn btn-primary min-h-11"
        disabled={state === "busy"}
        onClick={() => void sync()}
      >
        {state === "done" ? (
          <Check aria-hidden className="h-4 w-4" />
        ) : (
          <RefreshCw aria-hidden className={`h-4 w-4 ${state === "busy" ? "animate-spin" : ""}`} />
        )}
        {state === "busy" ? "Updating..." : "Sync Google Sheet"}
      </button>
      <span className={`min-h-4 max-w-sm text-right text-xs ${state === "failed" ? "text-[var(--color-danger)]" : "text-[var(--color-ink-faint)]"}`} aria-live="polite">
        {state === "done" || state === "failed" ? resultText : ""}
        {resultAction ? (
          <Link href={resultAction.href} className="ml-1.5 font-semibold underline underline-offset-2">
            {resultAction.label}
          </Link>
        ) : null}
      </span>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, RefreshCw } from "lucide-react";

type State = "idle" | "busy" | "done" | "failed";

export default function GoogleSheetSyncButton() {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [resultText, setResultText] = useState("");

  async function sync() {
    if (state === "busy") return;
    setState("busy");
    setResultText("");
    try {
      const response = await fetch("/api/sync/run", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        writeback?: { status?: string };
      };
      if (!response.ok || body.ok !== true) {
        setState("failed");
        return;
      }
      setState("done");
      setResultText("Google Sheet updated.");
      router.refresh();
    } catch {
      setState("failed");
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
      <span className={`min-h-4 text-xs ${state === "failed" ? "text-[var(--color-danger)]" : "text-[var(--color-ink-faint)]"}`} aria-live="polite">
        {state === "done" ? resultText : state === "failed" ? "Could not update. Try again." : ""}
      </span>
    </div>
  );
}

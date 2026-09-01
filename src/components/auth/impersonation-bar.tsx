import { RotateCcw } from "lucide-react";
import type { CurrentImpersonation } from "@/lib/auth/session";

export default function ImpersonationBar({
  impersonation,
  accountLabel,
}: {
  impersonation: CurrentImpersonation;
  accountLabel: string;
}) {
  return (
    <div
      role="status"
      className="sticky top-0 z-[90] flex h-11 items-center border-b border-[#b78314] bg-[#fff4cf] px-3 text-sm text-[#5f4100] shadow-sm"
    >
      <div className="mx-auto flex w-full max-w-[100rem] items-center justify-between gap-3">
        <p className="min-w-0 truncate">
          Viewing as <strong>{impersonation.target.displayName}</strong> - {accountLabel}
        </p>
        <form method="post" action="/api/auth/impersonation/stop" className="shrink-0">
          <button
            type="submit"
            className="btn btn-sm border-[#9b6d0a] bg-white text-[#5f4100] hover:bg-[#fff9e8]"
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
            <span className="hidden sm:inline">Return to owner portal</span>
            <span className="sm:hidden">Return</span>
          </button>
        </form>
      </div>
    </div>
  );
}

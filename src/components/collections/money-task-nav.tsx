import Link from "next/link";

export type MoneyTask = "collect" | "pay" | "put-away" | "checks" | "history";

/** One task bar for both the monthly summary and the detailed payment ledger. */
export function MoneyTaskNav({ active, month }: { active: MoneyTask; month?: string }) {
  const tasks: Array<{ id: MoneyTask; label: string; href: string }> = [
    { id: "collect", label: "Collect", href: "/masser" },
    { id: "pay", label: "Pay", href: "/settlements?queue=payable" },
    { id: "put-away", label: "Put away", href: "/masser?task=put-away" },
    { id: "checks", label: "Checks", href: "/masser?view=checks" },
    { id: "history", label: "History", href: "/settlements?view=history" },
  ];
  return <nav aria-label="Money tasks" className="mb-4 flex gap-1 overflow-x-auto border-b border-[var(--color-rule-strong)]">
    {tasks.map((task) => <Link key={task.id} aria-current={active === task.id ? "page" : undefined}
      href={`${task.href}${month ? `${task.href.includes("?") ? "&" : "?"}month=${encodeURIComponent(month)}` : ""}`}
      className={`touch-target shrink-0 border-b-2 px-4 py-3 text-sm font-semibold ${active === task.id ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
      {task.label}
    </Link>)}
  </nav>;
}

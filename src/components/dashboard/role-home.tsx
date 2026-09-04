import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  FileText,
  GraduationCap,
  HandCoins,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import type { RoleHomeActionId, RoleHomeDefinition } from "@/lib/dashboard/role-home";

const ICONS: Record<RoleHomeActionId, LucideIcon> = {
  people: WalletCards,
  employees: Users,
  transactions: ReceiptText,
  schedule: CalendarDays,
  masser: HandCoins,
  settlements: HandCoins,
  classes: GraduationCap,
  documents: FileText,
  portal: ShieldCheck,
  account: Settings2,
};

export default function RoleHome({ definition }: { definition: RoleHomeDefinition }) {
  const [first, ...more] = definition.actions;
  const FirstIcon = first ? ICONS[first.id] : null;
  return (
    <>
      <PageHeader
        eyebrow={definition.eyebrow}
        title={definition.title}
        description={definition.description}
      />

      {first ? (
        <section aria-labelledby="role-home-start">
          <p className="eyebrow text-[var(--color-ink-faint)]">Start here</p>
          <h2 id="role-home-start" className="display mt-1 text-lg font-semibold text-[var(--color-ink)]">
            Your next workspace
          </h2>
          <Link
            href={first.href}
            className="group mt-3 flex min-h-24 items-center gap-4 border-y border-[var(--color-rule-strong)] px-1 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            {FirstIcon ? (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
                <FirstIcon className="h-5 w-5" aria-hidden />
              </span>
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{first.label}</span>
              <span className="mt-0.5 block text-sm leading-5 text-[var(--color-ink-soft)]">{first.description}</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
          </Link>
        </section>
      ) : null}

      {more.length > 0 ? (
        <section aria-labelledby="role-home-more" className="mt-9">
          <h2 id="role-home-more" className="display text-lg font-semibold text-[var(--color-ink)]">Also available</h2>
          <div className="mt-3 grid gap-x-8 border-y border-[var(--color-rule-strong)] md:grid-cols-2">
            {more.map((action) => {
              const Icon = ICONS[action.id];
              return (
                <Link key={action.id} href={action.href} className="group flex min-h-20 items-center gap-3 border-t border-[var(--color-rule)] px-1 py-3 first:border-t-0 md:[&:nth-child(-n+2)]:border-t-0">
                  <Icon className="h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold group-hover:text-[var(--color-primary)]">{action.label}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--color-ink-soft)]">{action.description}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-faint)]" aria-hidden />
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}

import { AlertTriangle } from 'lucide-react';
import type { OperationalFlag } from '@/lib/business/operational-responsibility';
export default function OperationalFlags({ flags }: { flags: OperationalFlag[] }) {
  if (!flags.length) return null;
  return <section aria-label="Record review" className="mb-5 space-y-2">
    {flags.map((flag) => <div key={flag.key} className="flex flex-wrap items-start gap-2 rounded border border-[var(--color-rule)] px-3 py-2 text-sm">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" />
      <p className="min-w-0 flex-1 text-[var(--color-ink)]">{flag.message}</p>
      <a className="font-semibold text-[var(--color-primary)] underline" href={flag.href}>{flag.action}</a>
    </div>)}
  </section>;
}

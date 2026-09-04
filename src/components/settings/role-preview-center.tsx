import Link from "next/link";
import { Eye, EyeOff, MapPin } from "lucide-react";
import {
  ACCOUNT_PRESETS,
  type AccountPresetId,
} from "@/lib/auth/account-presets";
import {
  ROLE_PREVIEW_DETAILS,
  type RolePreviewAccount,
} from "@/lib/auth/role-preview";
import RolePreviewAccountPicker from "@/components/settings/role-preview-account-picker";

export default function RolePreviewCenter({
  accountsByPreset,
}: {
  accountsByPreset: Record<AccountPresetId, RolePreviewAccount[]>;
}) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      {ACCOUNT_PRESETS.map((preset) => {
        const details = ROLE_PREVIEW_DETAILS[preset.id];
        return (
          <article key={preset.id} className="card overflow-hidden">
            <header className="border-b border-[var(--color-rule)] px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="eyebrow text-[var(--color-primary)]">Account preset</p>
                  <h2 className="display mt-1 text-lg font-semibold text-[var(--color-ink)]">{preset.label}</h2>
                </div>
                <span className="rounded-full border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink-soft)]">
                  {accountsByPreset[preset.id].length} active {accountsByPreset[preset.id].length === 1 ? "account" : "accounts"}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">{preset.description}</p>
            </header>

            <div className="space-y-4 px-5 py-4">
              <div className="flex items-start gap-2 text-sm">
                <MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" />
                <div>
                  <p className="font-semibold text-[var(--color-ink)]">Main landing page</p>
                  <p className="text-[var(--color-ink-soft)]">
                    {details.landingLabel}{" "}
                    <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={details.landingHref}>
                      {details.landingHref}
                    </Link>
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <section className="rounded-lg bg-[var(--color-success-soft)] px-3.5 py-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-ink)]">
                    <Eye aria-hidden className="h-4 w-4 text-[var(--color-success)]" />
                    Preset intent — visible
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-ink-soft)]">{details.visible}</p>
                </section>
                <section className="rounded-lg bg-[var(--color-surface-muted)] px-3.5 py-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-ink)]">
                    <EyeOff aria-hidden className="h-4 w-4 text-[var(--color-ink-faint)]" />
                    Preset intent — hidden
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-ink-soft)]">{details.hidden}</p>
                </section>
              </div>

              <div className="border-t border-[var(--color-rule)] pt-4">
                <RolePreviewAccountPicker accounts={accountsByPreset[preset.id]} presetLabel={preset.label} />
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

import { requireUser } from "@/lib/auth/session";
import AppNav from "@/components/app-nav";

export const dynamic = "force-dynamic";

/**
 * Every screen inside this group is behind this one check. Middleware only
 * redirects on a missing cookie; this is where the signature is verified and
 * the account is re-read from the database.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("viewer");

  return (
    <div className="min-h-screen md:flex">
      <AppNav user={user} />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 pb-10 text-xs text-[var(--color-ink-faint)] sm:px-8">
          Ahivim Budget Management. Figures are read from the operational database; where a figure
          cannot be derived it is labelled as unavailable rather than estimated.
        </footer>
      </div>
    </div>
  );
}

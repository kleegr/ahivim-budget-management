import { requireUser } from "@/lib/auth/session";
import AppNav from "@/components/app-nav";
import { withDb } from "@/lib/data/pool";
import { exceptionCounts } from "@/lib/data/queries";

export const dynamic = "force-dynamic";

/**
 * Every screen inside this group is behind this one check. Middleware only
 * redirects on a missing cookie; this is where the signature is verified and
 * the account is re-read from the database.
 *
 * We also compute the total "Review" backlog here so the nav can wear a live
 * count badge and the user is pulled to it only when there is work to do.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("viewer");

  // The Review inbox rolls up every "needs a human" category into one number.
  // Failing quietly is the right choice: a broken count must never break the
  // whole layout — the user still has to be able to navigate.
  let reviewCount = 0;
  const counts = await withDb((pool) => exceptionCounts(pool));
  if (counts.ok) {
    const c = counts.data;
    reviewCount =
      c.rateExceptions +
      c.unmatchedNames +
      c.pendingAliases +
      c.duplicateCandidates +
      c.groupReviewIssues +
      c.reconciliationDifferences +
      c.overAuthorization +
      c.unknownPrograms;
  }

  return (
    <div className="min-h-screen md:flex">
      <AppNav user={user} reviewCount={reviewCount} />
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

import { requireUser, roleAtLeast } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
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
  const isManager = roleAtLeast(user.role, "manager");

  // The Review inbox rolls up every "needs a human" category into one number.
  // Failing quietly is the right choice: a broken count must never break the
  // whole layout — the user still has to be able to navigate.
  // The badge counts DECISIONS a person must make — a name that is ambiguous, a
  // possible duplicate person to merge, an alias to approve, an unmapped program,
  // or an import that did not reconcile. Monitoring metrics that need no decision
  // (rate exceptions, possible-duplicate rows that already imported, group-session
  // grouping, over-budget individuals) are shown on their own screens, not counted
  // here — so the badge means "there is something for you to resolve", not noise.
  // We also read the user's access scope so the nav can hide Transactions from a
  // viewer who isn't permitted to see it.
  let reviewCount = 0;
  let canSeeTransactions = true;
  const loaded = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const counts = isManager ? await exceptionCounts(pool) : null;
    return { canSeeTransactions: scope.canSeeTransactions, counts };
  });
  if (loaded.ok) {
    canSeeTransactions = loaded.data.canSeeTransactions;
    const c = loaded.data.counts;
    if (c) {
      reviewCount =
        c.unmatchedNames +
        c.duplicateIndividuals +
        c.pendingAliases +
        c.unknownPrograms +
        c.reconciliationDifferences;
    }
  }

  return (
    <div className="min-h-screen md:flex">
      <AppNav user={user} reviewCount={reviewCount} canSeeTransactions={canSeeTransactions} />
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

import { resolveConnectionEnvName } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * System status. Deliberately the landing page for this milestone: the import
 * and report screens are not wired up yet, and an operator's first question
 * after a deploy is whether the database is reachable and migrated.
 */
export default async function StatusPage() {
  const connectionVariable = resolveConnectionEnvName();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="eyebrow">Ahivim</p>
      <h1 className="display mt-1 text-3xl font-medium">Budget Management</h1>
      <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
        Authorization and utilization tracking for individual service programs. This deployment is
        the Project 2 foundation: the financial rules, the workbook parser and the import staging
        pipeline are in place and covered by tests.
      </p>

      <section className="mt-8 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-4">
        <p className="eyebrow">Database</p>
        <p className="mt-1 text-sm">
          {connectionVariable ? (
            <>
              A connection string is configured in{" "}
              <code className="rounded bg-[var(--color-primary-soft)] px-1.5 py-0.5 text-[var(--color-primary)]">
                {connectionVariable}
              </code>
              .
            </>
          ) : (
            "No Neon connection variable is set on this deployment."
          )}
        </p>
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
          Check <code>/api/health/env</code> for which variables are present, and{" "}
          <code>/api/health/db</code> for live connectivity, applied migrations and row counts.
          Neither endpoint ever returns a secret value.
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-4">
        <p className="eyebrow">Next step</p>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Run the migrations, then sign-in, upload and reporting screens can be enabled. See{" "}
          <code>docs/deployment.md</code> and <code>docs/handoff-project-2.md</code>.
        </p>
      </section>
    </main>
  );
}

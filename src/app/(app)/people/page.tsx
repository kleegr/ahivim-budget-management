import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { dashboardSummary } from "@/lib/data/queries";
import { PageHeader, Card, ErrorPanel } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "People — Ahivim Budget Management" };

/*
  People — the hub for both sides of the same data shape.

  "Individual" (the person receiving services) and "Employee" (the person
  providing them) used to be two separate top-level destinations. Every
  question you ask about one, you ask about the other — how many are there,
  where do I find one, what did we bill them, are they still active. So the
  nav now offers a single "People" door that lets you pick which side you're
  looking at, and each of the underlying screens is one click away.
*/

export default async function PeoplePage() {
  await requireUser("viewer");
  const result = await withDb((pool) => dashboardSummary(pool));

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="People"
        description="Individuals receive services; employees provide them. Same shape of information — pick the side you're looking at."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load people counts">{result.error}</ErrorPanel>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <PersonTile
            href="/individuals"
            title="Individuals"
            subtitle="People we're serving"
            count={result.data.individuals}
            hint="Budgets, approved hours, plans, and per-person pace."
          />
          <PersonTile
            href="/employees"
            title="Employees"
            subtitle="People providing services"
            count={result.data.employees}
            hint="Sessions worked, hours (physical vs allocated), programs served."
          />
        </div>
      )}

      <Card
        className="mt-8"
        title="Names & merging"
        description="When two records look like the same person, or a name comes in with a new spelling, the Review inbox is where a human confirms it — it never happens silently."
      >
        <div className="px-5 py-4 text-sm">
          <Link className="btn btn-sm btn-secondary" href="/review">
            Open the Review inbox
          </Link>
        </div>
      </Card>
    </>
  );
}

function PersonTile({
  href,
  title,
  subtitle,
  count,
  hint,
}: {
  href: string;
  title: string;
  subtitle: string;
  count: number;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="card block px-5 py-5 transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">{subtitle}</p>
          <p className="display mt-1 text-lg font-semibold">{title}</p>
        </div>
        <p className="tnum text-3xl font-semibold leading-none text-[var(--color-primary)]">
          {count.toLocaleString()}
        </p>
      </div>
      <p className="mt-3 text-sm text-[var(--color-ink-soft)]">{hint}</p>
      <p className="mt-4 text-xs font-medium text-[var(--color-primary)]">
        Open the {title.toLowerCase()} list →
      </p>
    </Link>
  );
}

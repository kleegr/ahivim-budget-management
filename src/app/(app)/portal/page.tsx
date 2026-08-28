import { requireUser } from "@/lib/auth/session";
import { resolvePortalAccess } from "@/lib/auth/portal-access";
import { getPortalHomeReadModel, normalizePortalMonth } from "@/lib/data/portal-read-model";
import { withDb } from "@/lib/data/pool";
import PortalHome from "@/components/portal/portal-home";
import { ErrorPanel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "My portal - Ahivim Budget Management" };

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const month = normalizePortalMonth((await searchParams).month);
  const user = await requireUser("viewer");
  const result = await withDb(async (pool) => {
    const access = await resolvePortalAccess(pool, user);
    return getPortalHomeReadModel(pool, access, month);
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="My portal" title="Portal unavailable" />
        <ErrorPanel title="Could not load your portal">{result.error}</ErrorPanel>
      </>
    );
  }
  return <PortalHome displayName={user.displayName} model={result.data} />;
}

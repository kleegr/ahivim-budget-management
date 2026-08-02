import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { PageHeader, ErrorPanel } from "@/components/ui";
import SyncConsole from "@/components/sync/sync-console";
import { getSyncConfig, sheetEditUrl } from "@/lib/sheets/config";
import { getSyncStatus, listSyncRuns, listOpenConflicts } from "@/lib/sheets/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sync — Ahivim Budget Management" };

export default async function SyncPage() {
  const user = await requireUser("viewer");
  const result = await withDb(async (pool) => {
    const [config, status, runs, conflicts] = await Promise.all([
      getSyncConfig(pool),
      getSyncStatus(pool),
      listSyncRuns(pool, 50),
      listOpenConflicts(pool, { limit: 200 }),
    ]);
    return { config, status, runs, conflicts };
  });

  return (
    <>
      <PageHeader
        eyebrow="Transactions"
        title="Sheet sync"
        description="The Google Sheet is the source of truth for Transactions. New rows import automatically every day; changes and removals are surfaced here for review — never applied or deleted silently."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load the sync status">{result.error}</ErrorPanel>
      ) : (
        <SyncConsole
          canManage={user.role !== "viewer"}
          isAdmin={user.role === "admin"}
          status={result.data.status}
          config={result.data.config}
          runs={result.data.runs}
          conflicts={result.data.conflicts}
          sheetUrl={sheetEditUrl(result.data.config)}
        />
      )}
    </>
  );
}

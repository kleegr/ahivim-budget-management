import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { PageHeader, ErrorPanel } from "@/components/ui";
import SyncConsole from "@/components/sync/sync-console";
import { getSyncConfig, sheetEditUrl } from "@/lib/sheets/config";
import { getSyncStatus, listSyncRuns, listOpenConflicts } from "@/lib/sheets/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sync — Ahivim Budget Management" };

export default async function SyncPage() {
  const user = await requireUser("manager");
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
        eyebrow="Data source"
        title="Automatic sync"
        description="Monitor source freshness, imported changes, and conflicts awaiting review."
      />

      {!result.ok ? (
        <ErrorPanel title="Sync status is unavailable">{result.error}</ErrorPanel>
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

import type { PgLikePool } from "@/lib/import/commit";
import { getSetting, setSetting } from "@/lib/manage/app-settings";
import { ok, fail, type Result } from "@/lib/manage/errors";

/**
 * Saved views for the spreadsheet workspaces (Transactions, Calculations).
 *
 * A view is a named snapshot of a grid's filter / sort / visible-column state.
 * The `config` is opaque JSON owned by the client grid — the server only stores
 * and lists it, so adding a new grid feature never needs a schema change.
 * Views are shared by the team (stored globally in `app_settings.grid_views`),
 * which is what a small back-office team wants: one person's "Com Hab, this
 * quarter" view is available to everyone.
 */
export interface GridView {
  id: string;
  gridKey: string;
  name: string;
  config: unknown;
  createdBy: string | null;
  createdAt: string;
}

const SETTINGS_KEY = "grid_views";
const MAX_VIEWS_PER_GRID = 100;

type Store = Record<string, GridView[]>;

async function readStore(pool: PgLikePool): Promise<Store> {
  const raw = await getSetting<Store>(pool, SETTINGS_KEY);
  return raw && typeof raw === "object" ? raw : {};
}

export async function listGridViews(pool: PgLikePool, gridKey: string): Promise<GridView[]> {
  const store = await readStore(pool);
  return (store[gridKey] ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveGridView(
  pool: PgLikePool,
  input: { gridKey: string; name: string; config: unknown },
  actorId: string | null,
): Promise<Result<GridView>> {
  const gridKey = String(input.gridKey ?? "").trim();
  const name = String(input.name ?? "").trim();
  if (!gridKey) return fail("validation", "A grid is required.");
  if (!name) return fail("validation", "A view name is required.");
  if (name.length > 80) return fail("validation", "View names are limited to 80 characters.");

  const store = await readStore(pool);
  const views = store[gridKey] ?? [];
  if (views.length >= MAX_VIEWS_PER_GRID && !views.some((v) => v.name === name)) {
    return fail("validation", "Too many saved views for this workspace. Delete some first.");
  }

  // Saving over an existing name replaces it (an in-place update, not a duplicate).
  const id =
    views.find((v) => v.name === name)?.id ??
    `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const view: GridView = {
    id,
    gridKey,
    name,
    config: input.config ?? null,
    createdBy: actorId,
    createdAt: new Date().toISOString(),
  };
  store[gridKey] = [...views.filter((v) => v.id !== id), view];
  await setSetting(pool, SETTINGS_KEY, store, actorId);
  return ok(view);
}

export async function deleteGridView(
  pool: PgLikePool,
  input: { gridKey: string; id: string },
  actorId: string | null,
): Promise<Result<{ id: string }>> {
  const store = await readStore(pool);
  const views = store[input.gridKey] ?? [];
  const next = views.filter((v) => v.id !== input.id);
  if (next.length === views.length) return fail("not_found", "That saved view no longer exists.");
  store[input.gridKey] = next;
  await setSetting(pool, SETTINGS_KEY, store, actorId);
  return ok({ id: input.id });
}

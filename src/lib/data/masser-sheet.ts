import type { PgLikePool } from "@/lib/import/commit";
import { toMoney } from "@/lib/money";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import type { BudgetCandidate } from "@/lib/data/financial-dashboard";

/**
 * The Masser board read model — the CUTS / CALCULATION sheet, one row per plan
 * (calculation strategy), exactly the shape of the workbook's summary tab: the
 * two cut percentages, the clock and other adjustments, the authorized hours per
 * program (the budget), then the computed yearly gross → monthly gross → gross
 * net → net, and finally the entered approved monthly final. It reuses the
 * canonical strategy calculator, so every figure matches the Financial sheet and
 * each individual's own plan. Per-person side info (a phone, an account tag and
 * notes) rides along on each row, editable inline.
 *
 * Actual billed money (agency made, employees made, taxes) is deliberately NOT
 * here — that lives with the transactions. This board is the plan.
 */

export interface MasserProgram {
  id: string;
  code: string;
  name: string;
  rate: string; // effective internal rate, shown under the program header
}

export interface MasserSheetRow {
  strategyId: string;
  individualId: string;
  individualName: string;
  label: string; // the plan label (an individual can have more than one)
  active: boolean;
  account: string | null; // individual.category
  phone: string | null;
  notes: string | null;
  renewalDate: string | null;
  monthDivisor: string;
  cut1Percent: string; // stored fraction (0.24)
  cut2Percent: string;
  clockAdjustment: string;
  otherAdjustment: string;
  hours: Record<string, string>; // programId -> authorized hours
  yearlyGross: string;
  monthlyGross: string;
  grossNet: string;
  net: string;
  masser: string | null; // after_all
}

export interface MasserSheet {
  rows: MasserSheetRow[];
  programs: MasserProgram[];
  candidates: BudgetCandidate[];
  accountOptions: string[];
}

/** The default account-tag choices, used until the admin edits the list. */
export const DEFAULT_ACCOUNT_OPTIONS = ["Account", "Guardianship", "Rep payee", "Self-directed", "Family"];
const ACCOUNT_OPTIONS_KEY = "masser_account_options";

export async function getAccountOptions(pool: PgLikePool): Promise<string[]> {
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [ACCOUNT_OPTIONS_KEY],
  );
  const v = rows[0]?.value;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return DEFAULT_ACCOUNT_OPTIONS;
}

export async function setAccountOptions(
  pool: PgLikePool,
  options: string[],
  actorId: string | null,
): Promise<string[]> {
  // Normalise: trim, drop blanks, de-dupe (case-insensitive), keep order, cap length.
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of options) {
    const o = String(raw ?? "").trim();
    if (!o) continue;
    const k = o.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(o);
    if (clean.length >= 50) break;
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by_user_id, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
    [ACCOUNT_OPTIONS_KEY, JSON.stringify(clean), actorId],
  );
  return clean;
}

/** Individuals with billing (or active) but no budget yet — the "Add budget" picker. */
export async function listBudgetCandidates(pool: PgLikePool, budgetedIds: string[]): Promise<BudgetCandidate[]> {
  const guard = budgetedIds.length ? budgetedIds : ["00000000-0000-0000-0000-000000000000"];
  const { rows } = await pool.query<{ id: string; name: string; tx_count: string; billed: string }>(
    `SELECT i.id,
            COALESCE(i.display_name, i.normalized_name) AS name,
            (SELECT count(*) FROM payroll_transactions t WHERE t.individual_id = i.id)::text AS tx_count,
            COALESCE((SELECT sum(t.imported_amount) FROM payroll_transactions t WHERE t.individual_id = i.id), 0)::text AS billed
       FROM individuals i
      WHERE NOT (i.id = ANY($1::uuid[]))
        AND i.merged_into_id IS NULL
        AND (i.status = 'active'
             OR EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.individual_id = i.id))
      ORDER BY billed DESC NULLS LAST, name`,
    [guard],
  );
  return rows.map((c) => ({ id: c.id, name: c.name, txCount: Number(c.tx_count), billed: toMoney(c.billed) }));
}

export async function getMasserSheet(pool: PgLikePool): Promise<MasserSheet> {
  const { rows: strategies, programs } = await listStrategies(pool, {});
  const indIds = [...new Set(strategies.map((s) => s.individualId))];

  const side = new Map<string, { phone: string | null; category: string | null; notes: string | null }>();
  if (indIds.length) {
    const { rows } = await pool.query<{ id: string; phone: string | null; category: string | null; notes: string | null }>(
      `SELECT id, phone, category, notes FROM individuals WHERE id = ANY($1::uuid[])`,
      [indIds],
    );
    for (const r of rows) side.set(r.id, { phone: r.phone, category: r.category, notes: r.notes });
  }

  const rows: MasserSheetRow[] = strategies.map((s) => {
    const info = side.get(s.individualId);
    return {
      strategyId: s.id,
      individualId: s.individualId,
      individualName: s.individualName,
      label: s.label,
      active: s.active,
      account: info?.category ?? null,
      phone: info?.phone ?? null,
      notes: info?.notes ?? null,
      renewalDate: s.renewalDate,
      monthDivisor: s.monthDivisor,
      cut1Percent: s.cut1Percent,
      cut2Percent: s.cut2Percent,
      clockAdjustment: s.clockAdjustment,
      otherAdjustment: s.otherAdjustment,
      hours: s.hours,
      yearlyGross: s.yearlyGross,
      monthlyGross: s.monthlyGross,
      grossNet: s.grossNet,
      net: s.net,
      masser: s.afterAll,
    };
  });

  const [candidates, accountOptions] = await Promise.all([
    listBudgetCandidates(pool, indIds),
    getAccountOptions(pool),
  ]);

  return {
    rows,
    programs: programs.map((p) => ({ id: p.id, code: p.code, name: p.name, rate: p.internalRate })),
    candidates,
    accountOptions,
  };
}

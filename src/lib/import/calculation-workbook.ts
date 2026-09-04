import { agencyDate } from "@/lib/business/agency-time";
import {
  budgetRateDate,
  computeStrategy,
  programBudgetPeriod,
} from "@/lib/business/calculation-strategy";
import {
  matchPerson,
  type AliasRecord,
  type CanonicalRecord,
  type NameMatchSuggestion,
} from "@/lib/business/name-matching";
import { pickEffectiveRateRow } from "@/lib/business/rate-resolver";
import type {
  CalculationsWorkbookParseResult,
  CalculationWorkbookIssue,
  CalculationWorkbookProgramCode,
  ParsedCalculationWorkbookRow,
} from "@/lib/excel/parse-calculations-workbook";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec, toMoney } from "@/lib/money";
import { recordChange } from "@/lib/manage/audit";

export const CALCULATION_WORKBOOK_CLASSIFICATIONS = [
  "exact",
  "missing",
  "different",
  "ambiguous",
  "duplicate",
  "historical",
  "needs-review",
] as const;

export type CalculationWorkbookClassification =
  (typeof CALCULATION_WORKBOOK_CLASSIFICATIONS)[number];

export interface CalculationWorkbookDifference {
  field: string;
  source: string | null;
  database: string | null;
}

export interface CalculationWorkbookReconciliationRow {
  sourceRowNumber: number;
  sourceIndividualLabel: string;
  normalizedIndividualLabel: string;
  strategyLabel: string;
  sourceRowHashSha256: string;
  classification: CalculationWorkbookClassification;
  classificationReason: string;
  individualId: string | null;
  individualName: string | null;
  identityMatch: "exact" | "alias" | "unmatched" | "ambiguous";
  identitySuggestions: NameMatchSuggestion[];
  strategyId: string | null;
  differences: CalculationWorkbookDifference[];
  issues: CalculationWorkbookIssue[];
  calculation: {
    sourceNet: string | null;
    effectiveRateNet: string | null;
    difference: string | null;
    approvedAfterAll: string | null;
    programRates: Array<{
      programCode: CalculationWorkbookProgramCode;
      programId: string;
      rateSource: "database-effective-schedule";
      effectiveRate: string;
      rateLookupDate: string | null;
      scheduleEffectiveFrom: string;
      scheduleEffectiveTo: string | null;
    }>;
  };
  safeToApply: boolean;
  applied: boolean;
}

export interface CalculationWorkbookReconciliationReport {
  mode: "dry-run" | "apply";
  source: {
    fileName: string;
    sheetName: string;
    range: string;
    checksumSha256: string;
    rateHints: Record<CalculationWorkbookProgramCode, string | null>;
    ratePolicy: "database-effective-dated-rates";
  };
  layoutValid: boolean;
  warnings: string[];
  rows: CalculationWorkbookReconciliationRow[];
  summary: Record<CalculationWorkbookClassification, number> & {
    sourceRows: number;
    insertedStrategies: number;
    recordedSourceRows: number;
  };
}

interface IndividualRow extends CanonicalRecord {
  status: string;
  archivedAt: string | null;
  phone: string | null;
}

interface ProgramRow {
  id: string;
  code: string;
  name: string;
}

interface RateScheduleRow {
  programId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  internalRate: string;
}

interface StrategyRow {
  id: string;
  individualId: string;
  label: string;
  renewalDate: string | null;
  monthDivisor: string;
  cut1Percent: string;
  cut2Percent: string;
  clockAdjustment: string;
  otherAdjustment: string;
  afterAll: string | null;
  account: string | null;
  notes: string | null;
  status: string;
}

interface StrategyLineRow {
  strategyId: string;
  programId: string;
  programCode: string;
  authorizedHours: string;
  rateOverride: string | null;
  rateOverrideEffectiveFrom: string | null;
}

interface ReconciliationContext {
  individuals: IndividualRow[];
  aliases: AliasRecord[];
  programsByCode: Map<string, ProgramRow>;
  schedulesByProgram: Map<string, RateScheduleRow[]>;
  strategies: StrategyRow[];
  linesByStrategy: Map<string, StrategyLineRow[]>;
}

interface InternalRow {
  source: ParsedCalculationWorkbookRow;
  public: CalculationWorkbookReconciliationRow;
  resolvedPrograms: Map<CalculationWorkbookProgramCode, ProgramRow>;
}

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

function normalizedOptionalText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function numericEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return dec(left).eq(dec(right));
}

function addNumericDifference(
  differences: CalculationWorkbookDifference[],
  field: string,
  source: string | null,
  database: string | null,
): void {
  if (!numericEqual(source, database)) differences.push({ field, source, database });
}

function addTextDifference(
  differences: CalculationWorkbookDifference[],
  field: string,
  source: string | null,
  database: string | null,
): void {
  const left = normalizedOptionalText(source);
  const right = normalizedOptionalText(database);
  if (left !== right) differences.push({ field, source: left, database: right });
}

function normalizedPhone(value: string | null): string {
  return (value ?? "").replace(/\D/g, "");
}

async function loadContext(db: Queryable): Promise<ReconciliationContext> {
  const [individualResult, aliasResult, programResult, scheduleResult, strategyResult, lineResult] =
    await Promise.all([
      db.query<{
        id: string;
        normalized_name: string;
        display_name: string;
        status: string;
        archived_at: string | null;
        phone: string | null;
      }>(
        `SELECT id, normalized_name, display_name, status,
                archived_at::text, phone
           FROM individuals
          WHERE merged_into_id IS NULL`,
      ),
      db.query<{ normalized_alias: string; individual_id: string; status: "approved" }>(
        `SELECT normalized_alias, individual_id, status
           FROM individual_aliases
          WHERE status = 'approved' AND archived_at IS NULL`,
      ),
      db.query<{ id: string; code: string; name: string }>(
        `SELECT id, code, name
           FROM programs
          WHERE is_active = true AND archived_at IS NULL`,
      ),
      db.query<{
        program_id: string;
        effective_from: string;
        effective_to: string | null;
        internal_rate: string;
      }>(
        `SELECT program_id,
                to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
                internal_rate::text
           FROM program_rate_schedules
          WHERE archived_at IS NULL`,
      ),
      db.query<{
        id: string;
        individual_id: string;
        label: string;
        renewal_date: string | null;
        month_divisor: string;
        cut1_percent: string;
        cut2_percent: string;
        clock_adjustment: string;
        other_adjustment: string;
        after_all: string | null;
        account: string | null;
        notes: string | null;
        status: string;
      }>(
        `SELECT id, individual_id, label,
                to_char(renewal_date, 'YYYY-MM-DD') AS renewal_date,
                month_divisor::text, cut1_percent::text, cut2_percent::text,
                clock_adjustment::text, other_adjustment::text, after_all::text,
                account, notes, status
           FROM calculation_strategies`,
      ),
      db.query<{
        strategy_id: string;
        program_id: string;
        program_code: string;
        authorized_hours: string;
        rate_override: string | null;
        rate_override_effective_from: string | null;
      }>(
        `SELECT line.strategy_id, line.program_id, program.code AS program_code,
                line.authorized_hours::text, line.rate_override::text,
                to_char(line.rate_override_effective_from, 'YYYY-MM-DD') AS rate_override_effective_from
           FROM calculation_strategy_lines line
           JOIN programs program ON program.id = line.program_id`,
      ),
    ]);

  const schedulesByProgram = new Map<string, RateScheduleRow[]>();
  for (const row of scheduleResult.rows) {
    const schedules = schedulesByProgram.get(row.program_id) ?? [];
    schedules.push({
      programId: row.program_id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      internalRate: row.internal_rate,
    });
    schedulesByProgram.set(row.program_id, schedules);
  }
  const linesByStrategy = new Map<string, StrategyLineRow[]>();
  for (const row of lineResult.rows) {
    const lines = linesByStrategy.get(row.strategy_id) ?? [];
    lines.push({
      strategyId: row.strategy_id,
      programId: row.program_id,
      programCode: row.program_code,
      authorizedHours: row.authorized_hours,
      rateOverride: row.rate_override,
      rateOverrideEffectiveFrom: row.rate_override_effective_from,
    });
    linesByStrategy.set(row.strategy_id, lines);
  }
  return {
    individuals: individualResult.rows.map((row) => ({
      id: row.id,
      normalizedName: row.normalized_name,
      displayName: row.display_name,
      status: row.status,
      archivedAt: row.archived_at,
      phone: row.phone,
    })),
    aliases: aliasResult.rows.map((row) => ({
      normalizedAlias: row.normalized_alias,
      targetId: row.individual_id,
      status: row.status,
    })),
    programsByCode: new Map(programResult.rows.map((row) => [row.code, row])),
    schedulesByProgram,
    strategies: strategyResult.rows.map((row) => ({
      id: row.id,
      individualId: row.individual_id,
      label: row.label,
      renewalDate: row.renewal_date,
      monthDivisor: row.month_divisor,
      cut1Percent: row.cut1_percent,
      cut2Percent: row.cut2_percent,
      clockAdjustment: row.clock_adjustment,
      otherAdjustment: row.other_adjustment,
      afterAll: row.after_all,
      account: row.account,
      notes: row.notes,
      status: row.status,
    })),
    linesByStrategy,
  };
}

function effectiveRate(
  context: ReconciliationContext,
  program: ProgramRow,
  source: ParsedCalculationWorkbookRow,
  individual: IndividualRow,
  asOf: string,
): {
  rate: string;
  rateLookupDate: string | null;
  scheduleEffectiveFrom: string;
  scheduleEffectiveTo: string | null;
} | null {
  const period = programBudgetPeriod(
    program.code,
    source.renewalDate,
    individual.status === "active",
    asOf,
  );
  const rateLookupDate = budgetRateDate(period.end);
  const chosen = pickEffectiveRateRow(
    context.schedulesByProgram.get(program.id) ?? [],
    rateLookupDate ?? "9999-12-31",
  );
  if (!chosen) return null;
  return {
    rate: chosen.internalRate,
    rateLookupDate,
    scheduleEffectiveFrom: chosen.effectiveFrom,
    scheduleEffectiveTo: chosen.effectiveTo,
  };
}

function compareStrategy(
  source: ParsedCalculationWorkbookRow,
  strategy: StrategyRow,
  context: ReconciliationContext,
): CalculationWorkbookDifference[] {
  const differences: CalculationWorkbookDifference[] = [];
  addTextDifference(differences, "renewalDate", source.renewalDate, strategy.renewalDate);
  addNumericDifference(differences, "monthDivisor", source.monthDivisor, strategy.monthDivisor);
  addNumericDifference(differences, "cut1Percent", source.cut1Percent, strategy.cut1Percent);
  addNumericDifference(differences, "cut2Percent", source.cut2Percent, strategy.cut2Percent);
  addNumericDifference(differences, "clockAdjustment", source.clockAdjustment, strategy.clockAdjustment);
  addNumericDifference(differences, "otherAdjustment", source.otherAdjustment, strategy.otherAdjustment);
  addNumericDifference(differences, "afterAll", source.sourceResults.afterAll, strategy.afterAll);
  addTextDifference(differences, "account", source.account, strategy.account);
  addTextDifference(differences, "notes", source.notes, strategy.notes);

  const sourceHours = new Map<string, string>(
    source.programHours
      .filter((line) => line.authorizedHours !== null && !dec(line.authorizedHours).isZero())
      .map((line) => [line.programCode, line.authorizedHours!] as const),
  );
  const databaseLines = (context.linesByStrategy.get(strategy.id) ?? []).filter((line) =>
    !dec(line.authorizedHours).isZero() || line.rateOverride !== null,
  );
  const databaseHours = new Map(databaseLines.map((line) => [line.programCode, line]));
  const codes = new Set([...sourceHours.keys(), ...databaseHours.keys()]);
  for (const code of [...codes].sort()) {
    const sourceValue = sourceHours.get(code) ?? null;
    const databaseLine = databaseHours.get(code);
    addNumericDifference(
      differences,
      `programHours.${code}`,
      sourceValue,
      databaseLine?.authorizedHours ?? null,
    );
    if (databaseLine?.rateOverride !== null && databaseLine?.rateOverride !== undefined) {
      differences.push({
        field: `rateOverride.${code}`,
        source: null,
        database: databaseLine.rateOverride,
      });
    }
  }
  return differences;
}

function canCompute(source: ParsedCalculationWorkbookRow): boolean {
  return source.monthDivisor !== null
    && source.cut1Percent !== null
    && source.cut2Percent !== null
    && source.clockAdjustment !== null
    && source.otherAdjustment !== null
    && source.sourceResults.afterAll !== null;
}

function basePublicRow(source: ParsedCalculationWorkbookRow): CalculationWorkbookReconciliationRow {
  return {
    sourceRowNumber: source.sourceRowNumber,
    sourceIndividualLabel: source.sourceIndividualLabel,
    normalizedIndividualLabel: source.normalizedIndividualLabel,
    strategyLabel: source.strategyLabel,
    sourceRowHashSha256: source.sourceRowHashSha256,
    classification: "needs-review",
    classificationReason: "The source row needs review.",
    individualId: null,
    individualName: null,
    identityMatch: "unmatched",
    identitySuggestions: [],
    strategyId: null,
    differences: [],
    issues: [...source.issues],
    calculation: {
      sourceNet: source.sourceResults.net,
      effectiveRateNet: null,
      difference: null,
      approvedAfterAll: source.sourceResults.afterAll,
      programRates: [],
    },
    safeToApply: false,
    applied: false,
  };
}

async function reconcileRows(
  db: Queryable,
  parsed: CalculationsWorkbookParseResult,
  asOf: string,
): Promise<InternalRow[]> {
  const context = await loadContext(db);
  const rows: InternalRow[] = [];

  for (const source of parsed.rows) {
    const output = basePublicRow(source);
    const match = matchPerson(source.individualMatchLabel, context.individuals, context.aliases);
    output.identityMatch = match.outcome;
    output.identitySuggestions = match.suggestions;
    const individual = match.matchedId
      ? context.individuals.find((candidate) => candidate.id === match.matchedId) ?? null
      : null;
    if (individual) {
      output.individualId = individual.id;
      output.individualName = individual.displayName;
    }

    const resolvedPrograms = new Map<CalculationWorkbookProgramCode, ProgramRow>();
    if (individual && output.issues.length === 0 && canCompute(source)) {
      const calculationLines: Array<{
        programLabel: string;
        programId: string;
        hours: string;
        internalRate: string;
      }> = [];
      for (const line of source.programHours) {
        if (line.authorizedHours === null || dec(line.authorizedHours).isZero()) continue;
        const program = context.programsByCode.get(line.programCode);
        if (!program) {
          output.issues.push({
            code: "missing_program",
            message: `Canonical program ${line.programCode} is not configured.`,
            cell: line.sourceCell,
          });
          continue;
        }
        resolvedPrograms.set(line.programCode, program);
        const resolvedRate = effectiveRate(context, program, source, individual, asOf);
        if (resolvedRate === null) {
          output.issues.push({
            code: "missing_effective_rate",
            message: `No database rate is effective for ${line.programCode}.`,
            cell: line.sourceCell,
          });
          continue;
        }
        output.calculation.programRates.push({
          programCode: line.programCode,
          programId: program.id,
          rateSource: "database-effective-schedule",
          effectiveRate: resolvedRate.rate,
          rateLookupDate: resolvedRate.rateLookupDate,
          scheduleEffectiveFrom: resolvedRate.scheduleEffectiveFrom,
          scheduleEffectiveTo: resolvedRate.scheduleEffectiveTo,
        });
        calculationLines.push({
          programLabel: program.name,
          programId: program.id,
          hours: line.authorizedHours,
          internalRate: resolvedRate.rate,
        });
      }
      if (output.issues.length === 0) {
        const calculated = computeStrategy({
          lines: calculationLines,
          monthDivisor: source.monthDivisor!,
          cut1Percent: source.cut1Percent!,
          cut2Percent: source.cut2Percent!,
          clockAdjustment: source.clockAdjustment!,
          otherAdjustment: source.otherAdjustment!,
          afterAll: source.sourceResults.afterAll,
        });
        output.calculation.effectiveRateNet = calculated.net;
        output.calculation.difference = source.sourceResults.net === null
          ? null
          : toMoney(dec(source.sourceResults.net).minus(calculated.net));
      }
    }

    if (!parsed.layoutValid || output.issues.length > 0) {
      output.classification = "needs-review";
      output.classificationReason = !parsed.layoutValid
        ? "The workbook layout is not safe for automatic application."
        : "One or more source values or formulas require human review.";
      rows.push({ source, public: output, resolvedPrograms });
      continue;
    }
    if (!individual || match.outcome === "unmatched" || match.outcome === "ambiguous") {
      output.classification = "ambiguous";
      output.classificationReason = match.reason;
      rows.push({ source, public: output, resolvedPrograms });
      continue;
    }

    const matchingStrategies = context.strategies.filter((strategy) =>
      strategy.individualId === individual.id && strategy.label.trim() === source.strategyLabel,
    );
    if (matchingStrategies.length > 1) {
      output.classification = "ambiguous";
      output.classificationReason = "More than one database strategy has this individual and label.";
      rows.push({ source, public: output, resolvedPrograms });
      continue;
    }

    const strategy = matchingStrategies[0] ?? null;
    output.strategyId = strategy?.id ?? null;
    if (individual.status !== "active" || individual.archivedAt !== null) {
      if (strategy) output.differences.push(...compareStrategy(source, strategy, context));
      output.classification = "historical";
      output.classificationReason =
        "The canonical individual is inactive or archived, so the source row is historical and will not be imported.";
      rows.push({ source, public: output, resolvedPrograms });
      continue;
    }

    const phoneConflict = source.phone !== null
      && normalizedPhone(individual.phone) !== ""
      && normalizedPhone(source.phone) !== normalizedPhone(individual.phone);
    if (phoneConflict) {
      output.differences.push({
        field: "individual.phone",
        source: "source workbook value",
        database: "different existing value",
      });
    }

    if (!strategy) {
      if (phoneConflict) {
        output.classification = "needs-review";
        output.classificationReason = "The strategy is missing, but the source phone conflicts with the canonical record.";
      } else {
        output.classification = "missing";
        output.classificationReason = "The canonical individual exists, but this strategy label does not.";
        output.safeToApply = true;
      }
      rows.push({ source, public: output, resolvedPrograms });
      continue;
    }

    output.differences.push(...compareStrategy(source, strategy, context));
    if (strategy.status !== "active") {
      output.classification = "historical";
      output.classificationReason = "The matching strategy exists only as an archived historical record.";
    } else if (output.differences.length > 0) {
      output.classification = "different";
      output.classificationReason = "The source and active database strategy differ; nothing will be overwritten.";
    } else {
      output.classification = "exact";
      output.classificationReason = "All authoritative source inputs match the active database strategy.";
    }
    rows.push({ source, public: output, resolvedPrograms });
  }

  const duplicateGroups = new Map<string, InternalRow[]>();
  for (const row of rows) {
    if (!row.public.individualId || row.public.issues.length > 0) continue;
    const key = `${row.public.individualId}|${row.source.strategyLabel}`;
    const group = duplicateGroups.get(key) ?? [];
    group.push(row);
    duplicateGroups.set(key, group);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      row.public.classification = "duplicate";
      row.public.classificationReason = "More than one importable source row resolves to this individual and strategy label.";
      row.public.safeToApply = false;
    }
  }

  return rows;
}

function summaryFor(
  rows: CalculationWorkbookReconciliationRow[],
  insertedStrategies: number,
  recordedSourceRows: number,
): CalculationWorkbookReconciliationReport["summary"] {
  const counts = Object.fromEntries(
    CALCULATION_WORKBOOK_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<CalculationWorkbookClassification, number>;
  for (const row of rows) counts[row.classification] += 1;
  return {
    ...counts,
    sourceRows: rows.length,
    insertedStrategies,
    recordedSourceRows,
  };
}

function reportFor(
  parsed: CalculationsWorkbookParseResult,
  rows: CalculationWorkbookReconciliationRow[],
  mode: "dry-run" | "apply",
  insertedStrategies = 0,
  recordedSourceRows = 0,
): CalculationWorkbookReconciliationReport {
  return {
    mode,
    source: {
      fileName: parsed.sourceFileName,
      sheetName: parsed.sourceSheetName,
      range: parsed.sourceRange,
      checksumSha256: parsed.checksumSha256,
      rateHints: parsed.sourceRateHints,
      ratePolicy: "database-effective-dated-rates",
    },
    layoutValid: parsed.layoutValid,
    warnings: [
      ...parsed.warnings,
      "Workbook rate cells are retained as audit hints only; effective-dated database rates drive every system calculation.",
    ],
    rows,
    summary: summaryFor(rows, insertedStrategies, recordedSourceRows),
  };
}

async function insertMissingStrategy(
  client: PgLikeClient,
  row: InternalRow,
  actorId: string | null,
  source: CalculationsWorkbookParseResult,
): Promise<string | null> {
  const input = row.source;
  if (!row.public.individualId || !row.public.safeToApply || !canCompute(input)) return null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO calculation_strategies
       (individual_id, label, renewal_date, month_divisor, cut1_percent, cut2_percent,
        clock_adjustment, other_adjustment, after_all, account, sort_order, notes,
        created_by_user_id)
     SELECT $1, $2, $3::date, $4::numeric, $5::numeric, $6::numeric,
            $7::numeric, $8::numeric, $9::numeric, $10, $11, $12, $13
      WHERE NOT EXISTS (
        SELECT 1 FROM calculation_strategies
         WHERE individual_id = $1 AND btrim(label) = $2
      )
     RETURNING id`,
    [
      row.public.individualId,
      input.strategyLabel,
      input.renewalDate,
      input.monthDivisor,
      input.cut1Percent,
      input.cut2Percent,
      input.clockAdjustment,
      input.otherAdjustment,
      input.sourceResults.afterAll,
      input.account,
      Number(input.strategyLabel),
      input.notes,
      actorId,
    ],
  );
  const strategyId = inserted.rows[0]?.id ?? null;
  if (!strategyId) return null;

  for (const line of input.programHours) {
    if (line.authorizedHours === null || dec(line.authorizedHours).isZero()) continue;
    const program = row.resolvedPrograms.get(line.programCode);
    if (!program) throw new Error(`Program ${line.programCode} was not resolved before apply.`);
    await client.query(
      `INSERT INTO calculation_strategy_lines
         (strategy_id, program_id, authorized_hours)
       VALUES ($1, $2, $3::numeric)`,
      [strategyId, program.id, line.authorizedHours],
    );
  }

  if (input.phone) {
    const updated = await client.query<{ id: string }>(
      `UPDATE individuals
          SET phone = $2, updated_at = now()
        WHERE id = $1 AND NULLIF(btrim(phone), '') IS NULL
      RETURNING id`,
      [row.public.individualId, input.phone],
    );
    if (updated.rows[0]) {
      await recordChange(client, {
        actorId,
        action: "calculation_workbook_phone_added",
        entityType: "individual",
        entityId: row.public.individualId,
        next: { phone: "added from source workbook" },
        reason: `Calculations workbook row ${input.sourceRowNumber}`,
        extra: { sourceChecksumSha256: source.checksumSha256 },
      });
    }
  }

  await recordChange(client, {
    actorId,
    action: "calculation_workbook_strategy_imported",
    entityType: "calculation_strategy",
    entityId: strategyId,
    next: {
      individualId: row.public.individualId,
      label: input.strategyLabel,
      approvedAfterAll: input.sourceResults.afterAll,
    },
    reason: `Imported from ${source.sourceFileName}, ${source.sourceSheetName} row ${input.sourceRowNumber}`,
    extra: {
      sourceChecksumSha256: source.checksumSha256,
      sourceRowHashSha256: input.sourceRowHashSha256,
    },
  });
  return strategyId;
}

async function recordSourceRow(
  client: PgLikeClient,
  parsed: CalculationsWorkbookParseResult,
  row: InternalRow,
  actorId: string | null,
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO calculation_strategy_import_rows
       (strategy_id, individual_id, source_file_name, source_sheet_name,
        source_row_number, source_checksum_sha256, source_row_hash_sha256,
        source_individual_label, strategy_label, classification, source_snapshot,
        reconciliation, applied_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
     ON CONFLICT (source_checksum_sha256, source_sheet_name, source_row_number) DO NOTHING
     RETURNING id`,
    [
      row.public.strategyId,
      row.public.individualId,
      parsed.sourceFileName,
      parsed.sourceSheetName,
      row.source.sourceRowNumber,
      parsed.checksumSha256,
      row.source.sourceRowHashSha256,
      row.source.sourceIndividualLabel,
      row.source.strategyLabel,
      row.public.classification,
      JSON.stringify(row.source.sourceSnapshot),
      JSON.stringify({
        classificationReason: row.public.classificationReason,
        identityMatch: row.public.identityMatch,
        identitySuggestions: row.public.identitySuggestions,
        differences: row.public.differences,
        issues: row.public.issues,
        calculation: row.public.calculation,
        safeToApply: row.public.safeToApply,
        applied: row.public.applied,
      }),
      actorId,
    ],
  );
  return result.rows.length === 1;
}

/**
 * Reconcile by default. Apply mode is explicit, serialized, and can create only
 * rows classified as unequivocally missing. Existing strategies are never
 * updated, archived, or overwritten.
 */
export async function reconcileCalculationWorkbook(
  pool: PgLikePool,
  parsed: CalculationsWorkbookParseResult,
  options: { apply?: boolean; actorId?: string | null; asOf?: string } = {},
): Promise<CalculationWorkbookReconciliationReport> {
  const asOf = (options.asOf ?? agencyDate()).slice(0, 10);
  if (options.apply !== true) {
    const reconciled = await reconcileRows(pool, parsed, asOf);
    return reportFor(parsed, reconciled.map((row) => row.public), "dry-run");
  }

  const actorId = options.actorId ?? null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A single lock serializes every Calculations-workbook apply, including two
    // different files that resolve to the same canonical strategy label.
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_747_004_041]);
    const reconciled = await reconcileRows(client, parsed, asOf);
    let insertedStrategies = 0;
    let recordedSourceRows = 0;

    for (const row of reconciled) {
      if (row.public.classification === "missing" && row.public.safeToApply) {
        const strategyId = await insertMissingStrategy(client, row, actorId, parsed);
        if (strategyId) {
          row.public.strategyId = strategyId;
          row.public.applied = true;
          insertedStrategies += 1;
        } else {
          row.public.safeToApply = false;
          row.public.classification = "ambiguous";
          row.public.classificationReason =
            "A strategy with this individual and label appeared before the guarded insert; nothing was overwritten.";
        }
      }
      if (await recordSourceRow(client, parsed, row, actorId)) recordedSourceRows += 1;
    }

    await client.query("COMMIT");
    return reportFor(
      parsed,
      reconciled.map((row) => row.public),
      "apply",
      insertedStrategies,
      recordedSourceRows,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

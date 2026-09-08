import { createHash, randomUUID } from "node:crypto";
import type { PgLikePool } from "@/lib/import/commit";
import { resolveAuditAttribution } from "@/lib/auth/audit-attribution";
import { createPersonIdentityResolver, type PersonIdentityDirectory } from "@/lib/business/person-identity";
import { calculateInternalAmount, isAgencyPayee } from "@/lib/business/internal-rate";
import { resolveProgram } from "@/lib/business/program-normalization";
import { dec } from "@/lib/money";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";
import { fail, ok, type Result } from "@/lib/manage/errors";
import { AHIVIM_HEADER_ALIASES, AHIVIM_POSITIONAL, type AhivimField } from "@/lib/excel/column-map";
import { DEFAULT_SHEET_ID, DEFAULT_SHEET_NAME, getSyncConfig } from "./config";
import { fetchSheetCsv, sheetValuesToCsv, type CsvFetcher } from "./fetch";
import { parseSheetCsv } from "./parse-csv";
import { sheetSourceIdentity, sheetSourceIdentityKey } from "./identity";
import { sourceNetCheckGroup } from "./source-net-check-group";

export interface SourceBaseProjection {
  base: string; employeePayment: string; agencyAdditional: string; mismatch: boolean;
}
export interface SourceBaseRecoveryCandidate {
  transactionId: string; sourceFileId: string | null; importRowId: string; sourceRowNumber: number | null;
  employee: string | null; individual: string | null; previous: SourceBaseProjection | null; next: SourceBaseProjection | null;
  eligible: boolean; reviewReason: string | null; paid: boolean; groupBudgetBasis: boolean;
}
export interface SourceBaseRecoveryHistory {
  acceptanceAuditId: string; acceptedAt: string; reason: string; transactionCount: number;
  reversedAt: string | null; reversalAuditId: string | null;
  previousTotals: Omit<SourceBaseProjection, "mismatch">; nextTotals: Omit<SourceBaseProjection, "mismatch">;
  groupBudgetBasisCount: number; canUndo: boolean; undoReviewReason: string | null;
  items: SourceBaseRecoveryHistoryItem[];
}
export interface SourceBaseRecoveryHistoryItem {
  transactionId:string; importRowId:string; sourceFileId:string|null; sourceRowNumber:number|null;
  individual:string|null; employee:string|null; previous:SourceBaseProjection; next:SourceBaseProjection;
}
export interface SourceBaseRecoveryReview {
  sourceHash: string | null; candidates: SourceBaseRecoveryCandidate[]; history: SourceBaseRecoveryHistory[];
  reviewReason: string | null;
}
export interface SourceBaseRecoveryInput {
  action: "accept" | "undo"; reason: string; operationKey: string; sourceHash: string;
  transactionIds?: string[]; acceptanceAuditId?: string;
}
export interface SourceBaseRecoveryResult {
  batchAuditId: string; acceptanceAuditId: string; transactionCount: number; alreadyApplied: boolean;
  status: "accepted" | "undone";
}

const ACCEPT = "source_base_recovery_accepted", REVERSE = "source_base_recovery_reversed";
const BATCH_ACCEPT = "source_base_recovery_batch_accepted", BATCH_REVERSE = "source_base_recovery_batch_reversed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const text = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const originalRaw = (value: Record<string, unknown>) => value.raw && typeof value.raw === "object" && !Array.isArray(value.raw)
  ? value.raw as Record<string, unknown> : value;
type Db = Pick<PgLikePool, "query">;
type Row = Record<string, unknown> & {
  id: string; employee_id: string | null; individual_id: string | null; import_row_id: string;
  employee: string | null; individual: string | null; source_file_id: string | null; source_row_number: number | null;
  raw_values: Record<string, unknown>; corrected_values: unknown; correction_status: string | null;
  other_fields_hash: string; warnings: Array<{ id: string; details: Record<string, unknown>; resolved_at: string | null }>;
};
type Audit = { id: string; entity_id: string | null; action: string; created_at: string; reason: string | null; metadata: Record<string, unknown> };
type Item = SourceBaseRecoveryHistoryItem & { auditId: string;
  originalSourceHash: string; otherFieldsHash: string; importRowId: string; sourceRowNumbers: number[];
  originalWarningHash:string; originalWarningIds:string[];
  groupBudgetBasis: boolean; appliedInternalRate: string; appliedAgencyRate: string };

function exact(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const amount = dec(value);
  return amount.decimalPlaces() <= 4 && amount.lt("10000000000") ? amount.toFixed(4) : null;
}
function projection(row: Row): SourceBaseProjection | null {
  const base = exact(row.calculated_internal_amount), employeePayment = exact(row.employee_payment_amount), agencyAdditional = exact(row.agency_additional_amount);
  return base !== null && employeePayment !== null && agencyAdditional !== null
    ? { base, employeePayment, agencyAdditional, mismatch: row.internal_amount_mismatch === true } : null;
}
function replacement(row: Row): SourceBaseProjection | null {
  const base = exact(row.spreadsheet_internal_amount), billed = exact(row.imported_amount);
  if (base === null || billed === null || !isAgencyPayee(String(row.pay_to_raw ?? "")) || row.payment_recipient !== "excellent_staffing") return null;
  const calculated = calculateInternalAmount({ payTo: String(row.pay_to_raw ?? ""), importedAmount: billed,
    internalRate: String(row.internal_rate_applied ?? ""), agencyRate: String(row.agency_rate_applied ?? "") });
  if (calculated.rule !== "agency_rate_converted" || calculated.internalAmount === null || !dec(calculated.internalAmount).eq(base)) return null;
  return { base, employeePayment: base, agencyAdditional: dec(billed).minus(base).isNegative() ? "0.0000" : dec(billed).minus(base).toFixed(4), mismatch: false };
}
function legacyReason(row: Row): string | null {
  if (!row.employee_id || !row.individual_id || !row.program_id) return "An approved employee, individual or program match is missing. Review the match first.";
  if (row.import_status !== "imported") return "The original import row is awaiting review. Resolve that review first.";
  if (row.is_paid === true || row.paid_at !== null) return "This row is marked Paid. Review its actual payment history before changing or undoing amounts.";
  const previous = projection(row), next = replacement(row), billed = exact(row.imported_amount);
  if (!previous || !next || billed === null) return "The original source, stored rates or payment projections need financial review.";
  if (row.corrected_values !== null || row.correction_status === "corrected") return "This source row already has a correction; review its history.";
  if (!previous.mismatch || previous.base !== billed || previous.employeePayment !== previous.base || previous.agencyAdditional !== "0.0000"
    || !dec(next.base).lt(previous.base)) return "These amounts do not match the documented historical calculation error.";
  if (!row.warnings.some(w => w.resolved_at === null && exact(w.details.application) === previous.base && exact(w.details.spreadsheet) === next.base)) {
    return "The original recorded calculation disagreement is unavailable or was already reviewed.";
  }
  return null;
}
function identity(row: Row) {
  return { checkNumber: row.check_number, checkDate: row.check_date, program: row.program_raw, individual: row.individual_raw,
    employee: row.employee_raw, periodBegin: row.period_begin, periodEnd: row.period_end, hours: row.imported_hours,
    rate: row.imported_rate, amount: row.imported_amount };
}
function compatible(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (!a.employee_id || a.employee_id !== b.employee_id) return false;
  const numberA = text(a.check_number), numberB = text(b.check_number);
  const date = (field: string) => !text(a[field]) || !text(b[field]) || text(a[field]) === text(b[field]);
  if (numberA && numberB) return numberA === numberB && date("check_date");
  const fields = ["check_date", "period_begin", "period_end"];
  return fields.every(date) && fields.some(field => text(a[field]) && text(a[field]) === text(b[field]));
}
async function loadRows(db: Db, ids?: string[]): Promise<Row[]> {
  return (await db.query<Row>(`SELECT t.*, to_char(t.check_date,'YYYY-MM-DD') AS check_date,
      to_char(t.period_begin,'YYYY-MM-DD') AS period_begin, to_char(t.period_end,'YYYY-MM-DD') AS period_end,
      i.raw_values, i.corrected_values, i.correction_status, i.status AS import_status,
      e.display_name AS employee, person.display_name AS individual, p.rate_scope,
      md5((to_jsonb(t) - ARRAY['calculated_internal_amount','internal_amount_mismatch','employee_payment_amount','agency_additional_amount'])::text) AS other_fields_hash,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'details',w.details,'resolved_at',w.resolved_at) ORDER BY w.id)
        FROM import_warnings w WHERE w.import_row_id=t.import_row_id AND w.category='internal_amount_mismatch'),'[]'::jsonb) AS warnings
    FROM payroll_transactions t JOIN import_rows i ON i.id=t.import_row_id
    LEFT JOIN employees e ON e.id=t.employee_id LEFT JOIN individuals person ON person.id=t.individual_id
    LEFT JOIN programs p ON p.id=t.program_id
    WHERE ${ids ? "t.id=ANY($1::uuid[])" : "t.internal_amount_mismatch=true"} ORDER BY t.id`, ids ? [ids] : [])).rows;
}

/** Check membership is transitive. Posted money with uncertain provenance is held conservatively. */
async function financialReasons(db: Db, selected: Row[]): Promise<Map<string, string>> {
  const transactions = (await db.query<Record<string, unknown>>(`SELECT id, employee_id, individual_id, payroll_check_id,
    check_number,to_char(check_date,'YYYY-MM-DD') AS check_date,to_char(period_begin,'YYYY-MM-DD') AS period_begin,
    to_char(period_end,'YYYY-MM-DD') AS period_end,is_paid,paid_at FROM payroll_transactions`)).rows;
  const checks = (await db.query<Record<string, unknown>>(`SELECT id,employee_id,check_number,
    to_char(check_date,'YYYY-MM-DD') AS check_date,to_char(period_begin,'YYYY-MM-DD') AS period_begin,
    to_char(period_end,'YYYY-MM-DD') AS period_end,verification_status FROM employee_payroll_checks`)).rows;
  const events = (await db.query<Record<string, unknown>>(`WITH RECURSIVE history AS (
      SELECT e.id AS event_id,e.employee_id AS event_employee,e.individual_id AS event_individual,o.id,
        o.employee_id,o.individual_id,o.calculation_metadata,ARRAY[o.id] AS visited
      FROM settlement_events e LEFT JOIN settlement_obligations o ON o.id=e.settlement_obligation_id
      UNION ALL SELECT h.event_id,h.event_employee,h.event_individual,parent.id,parent.employee_id,parent.individual_id,
        parent.calculation_metadata,h.visited||parent.id FROM history h JOIN settlement_obligations parent
        ON parent.id::text=h.calculation_metadata->>'adjustmentForObligationId' WHERE NOT parent.id=ANY(h.visited)
    ) SELECT h.*, COALESCE((SELECT jsonb_agg(l.payroll_transaction_id::text) FROM settlement_obligation_transactions l
       WHERE l.settlement_obligation_id=h.id),'[]'::jsonb) AS linked_sources FROM history h`)).rows;
  const reviews = (await db.query<{ payroll_transaction_id: string }>(`SELECT payroll_transaction_id FROM sheet_sync_conflicts WHERE status='open'`)).rows;
  const overridden = (await db.query<{ entity_id: string }>(`SELECT DISTINCT entity_id FROM audit_logs WHERE entity_type='payroll_transaction'
    AND entity_id=ANY($1::uuid[]) AND action NOT IN ($2,$3,'source_net_recovery_accepted','source_net_recovery_reversed')`,
  [selected.map(row => row.id), ACCEPT, REVERSE])).rows;
  const reasons = new Map<string, string>(), cached = new Map<string, Record<string, unknown>[]>();
  for (const target of selected) {
    let group = cached.get(target.id);
    if (!group) {
      group = [target];
      const seen = new Set([target.id]);
      for (let cursor = 0; cursor < group.length; cursor++) for (const row of transactions) {
        const member = group[cursor]!;
        if (!seen.has(String(row.id)) && (compatible(member, row)
          || (member.payroll_check_id !== null && member.payroll_check_id !== undefined && member.payroll_check_id === row.payroll_check_id))) {
          seen.add(String(row.id)); group.push(row);
        }
      }
      for (const member of group) cached.set(String(member.id), group);
    }
    const members = new Set(group.map(row => String(row.id))), people = new Set(group.flatMap(row => [row.employee_id,row.individual_id]).filter(Boolean));
    const groupChecks = checks.filter(check => group!.some(row => row.payroll_check_id === check.id || compatible(row, check)));
    const checkIds = new Set(groupChecks.map(check => String(check.id)));
    if (group.some(row => row.is_paid === true || row.paid_at != null)) reasons.set(target.id, "This row or another service on the same check is marked Paid. Review actual payment history first.");
    else if (groupChecks.some(check => check.verification_status !== "unverified")) reasons.set(target.id, "This check group has a verified or void check. It requires financial correction review.");
    else if (events.some(event => {
      const metadata = (event.calculation_metadata ?? {}) as Record<string, unknown>;
      const sourceIds = [...(Array.isArray(event.linked_sources) ? event.linked_sources : []),
        ...(Array.isArray(metadata.sourceTransactionIds) ? metadata.sourceTransactionIds : [])];
      return [event.event_employee,event.event_individual,event.employee_id,event.individual_id].some(id => people.has(id))
        || sourceIds.some(id => members.has(String(id))) || checkIds.has(String(metadata.payrollCheckId))
        || (!event.event_employee && !event.event_individual && !event.employee_id && !event.individual_id && !sourceIds.length);
    })) reasons.set(target.id, "Posted payment, credit or reversal history may depend on this employee or individual. Review that history first.");
    else if (reviews.some(review => members.has(review.payroll_transaction_id))) reasons.set(target.id, "This check group has another open source change. Resolve the source review first.");
    else if (overridden.some(audit => audit.entity_id === target.id)) reasons.set(target.id, "This transaction has another audited correction or override. Review its history first.");
  }
  return reasons;
}

function totals(items: Item[], side: "previous" | "next"): Omit<SourceBaseProjection, "mismatch"> {
  const sum = (field: "base" | "employeePayment" | "agencyAdditional") => items.reduce((value,item) => value.plus(item[side][field]),dec(0)).toFixed(4);
  return { base: sum("base"), employeePayment: sum("employeePayment"), agencyAdditional: sum("agencyAdditional") };
}

export async function listSourceBaseRecoveryReview(pool: PgLikePool, options: {fetcher?:CsvFetcher} = {}): Promise<SourceBaseRecoveryReview> {
  const rows = await loadRows(pool);
  const audits = (await pool.query<Audit>(`SELECT id,entity_id,action,created_at::text,reason,metadata FROM audit_logs
    WHERE action IN ($1,$2) ORDER BY created_at DESC,id`,[BATCH_ACCEPT,BATCH_REVERSE])).rows;
  const accepted = audits.filter(audit => audit.action === BATCH_ACCEPT);
  const historyIds = accepted.flatMap(audit => (audit.metadata.items as Item[] ?? []).map(item => item.transactionId));
  const historyRows = historyIds.length ? await loadRows(pool,[...new Set(historyIds)]) : [];
  const reasons = await financialReasons(pool,[...rows,...historyRows]);
  const config = await getSyncConfig(pool);
  const latest = (await pool.query<{ snapshot_sha256: string }>(`SELECT snapshot_sha256 FROM sheet_sync_runs
    WHERE status IN ('success','no_changes') AND snapshot_sha256 IS NOT NULL ORDER BY finished_at DESC NULLS LAST,created_at DESC LIMIT 1`)).rows[0];
  let sourceHash:string|null = null, reviewReason:string|null = "A successful sync from the designated read-only source is required before reviewing these amounts.";
  let evidence = new Map<string,{reason:string|null;rowNumbers:number[]}>();
  if (config.sheetId === DEFAULT_SHEET_ID && config.sheetName === DEFAULT_SHEET_NAME && SHA.test(latest?.snapshot_sha256 ?? "")) {
    try {
      const source = parseSheetCsv(await (options.fetcher ?? fetchSheetCsv)(config));
      if (source.snapshotSha256 !== latest!.snapshot_sha256) reviewReason = "The source changed since the last successful sync. Sync and review it before correcting amounts.";
      else {
        sourceHash = source.snapshotSha256; reviewReason = null;
        evidence = await sourceEvidence(pool,[...new Map([...rows,...historyRows].map(row => [row.id,row])).values()],source);
      }
    } catch { sourceHash = null; reviewReason = "The current read-only source could not be verified. Retry the source review before changing amounts."; }
  }
  return { sourceHash, reviewReason,
    candidates: rows.map(row => {
      const reason = reviewReason ?? reasons.get(row.id) ?? legacyReason(row) ?? evidence.get(row.id)?.reason ?? null;
      return { transactionId:row.id,sourceFileId:row.source_file_id,importRowId:row.import_row_id,sourceRowNumber:row.source_row_number,
        employee:row.employee,individual:row.individual,previous:projection(row),next:replacement(row),
        eligible:reason === null,reviewReason:reason,paid:row.is_paid === true || row.paid_at != null,groupBudgetBasis:row.rate_scope === "per_group" };
    }),
    history: accepted.map(audit => {
      const items = audit.metadata.items as Item[], reversal = audits.find(other => other.action === BATCH_REVERSE && other.metadata.acceptanceAuditId === audit.id);
      const changed = items.some(item => { const row = historyRows.find(value => value.id === item.transactionId);
        return !row || row.other_fields_hash !== item.otherFieldsHash || hash(row.raw_values) !== item.originalSourceHash || hash(row.warnings) !== item.originalWarningHash
          || hash(projection(row)) !== hash(item.next) || row.corrected_values !== null || row.correction_status === "corrected"; });
      const reason = reversal ? "This batch was already undone." : reviewReason ?? (sourceHash !== audit.metadata.sourceHash ? "The source changed after this acceptance; review it before Undo." : null)
        ?? items.map(item => reasons.get(item.transactionId) ?? evidence.get(item.transactionId)?.reason).find(Boolean) ?? (changed ? "An accepted transaction changed after this repair; review its history." : null);
      return { acceptanceAuditId:audit.id,acceptedAt:audit.created_at,reason:audit.reason ?? "",transactionCount:items.length,
        items:items.map(({transactionId,importRowId,sourceFileId,sourceRowNumber,individual,employee,previous,next}) =>
          ({transactionId,importRowId,sourceFileId,sourceRowNumber,individual,employee,previous,next})),
        reversedAt:reversal?.created_at ?? null,reversalAuditId:reversal?.id ?? null,previousTotals:totals(items,"previous"),nextTotals:totals(items,"next"),
        groupBudgetBasisCount:items.filter(item => item.groupBudgetBasis).length,canUndo:reason === null,undoReviewReason:reason };
    }) };
}

function originalParsed(row: Row) {
  const raw = originalRaw(row.raw_values), header: string[] = [], values: string[] = [];
  for (const [field,column] of Object.entries(AHIVIM_POSITIONAL)) {
    header[column-1] = AHIVIM_HEADER_ALIASES[field as AhivimField][0]!;
    values[column-1] = String(raw[field] ?? "");
  }
  return parseSheetCsv(sheetValuesToCsv([[],header,values])).ahivimRows[0]?.parsed;
}
function sameMappedSource(before: Record<string,unknown>, current: Record<string,unknown>): boolean {
  const numeric = new Set(["hours","rate","amount","calculatedInternalAmount","totalNetPay"]);
  return Object.entries(before).every(([field,value]) => {
    if (field === "paid") return true;
    const next = current[field];
    if (numeric.has(field) && text(value) && text(next)) {
      try { return dec(String(value)).eq(String(next)); } catch { return false; }
    }
    return text(value) === text(next);
  });
}
async function directories(db: Db): Promise<{ employees: PersonIdentityDirectory; individuals: PersonIdentityDirectory }> {
  const result = (await db.query<{ employees: PersonIdentityDirectory; individuals: PersonIdentityDirectory }>(`SELECT
    jsonb_build_object('people',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'normalizedName',normalized_name,'displayName',display_name,'status',status)),'[]') FROM employees),
      'aliases',(SELECT COALESCE(jsonb_agg(jsonb_build_object('normalizedAlias',normalized_alias,'targetId',employee_id,'status',status)),'[]') FROM employee_aliases),
      'merges',(SELECT COALESCE(jsonb_agg(jsonb_build_object('mergedId',metadata->>'mergedId','survivorId',entity_id,'mergedName',metadata->>'mergedName')),'[]') FROM audit_logs WHERE action='employees_merged' AND entity_type='employee')) AS employees,
    jsonb_build_object('people',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'normalizedName',normalized_name,'displayName',display_name,'status',status,'mergedIntoId',merged_into_id)),'[]') FROM individuals),
      'aliases',(SELECT COALESCE(jsonb_agg(jsonb_build_object('normalizedAlias',normalized_alias,'targetId',individual_id,'status',status)),'[]') FROM individual_aliases),
      'merges',(SELECT COALESCE(jsonb_agg(jsonb_build_object('mergedId',metadata->>'mergedId','survivorId',entity_id,'mergedName',metadata->>'mergedName')),'[]') FROM audit_logs WHERE action='individuals_merged' AND entity_type='individual')) AS individuals`)).rows[0];
  if (!result) throw new Error("Approved person matches are unavailable.");
  return result;
}

async function sourceEvidence(db:Db, rows:Row[], source:ReturnType<typeof parseSheetCsv>) {
  const directory = await directories(db), resolveEmployee = createPersonIdentityResolver(directory.employees,{},"employee"),
    resolveIndividual = createPersonIdentityResolver(directory.individuals,{},"individual");
  const programs = (await db.query<{id:string;code:string;normalized_alias:string}>(`SELECT p.id,p.code,a.normalized_alias
    FROM programs p JOIN program_aliases a ON a.program_id=p.id WHERE a.status='approved' AND p.is_active=true`)).rows;
  const programAliases = Object.fromEntries(programs.map(program => [program.normalized_alias,program.code]));
  const sourceByIdentity = new Map<string,typeof source.ahivimRows>();
  for (const row of source.ahivimRows) { const key = sheetSourceIdentityKey({...sheetSourceIdentity(row)});
    if (key) sourceByIdentity.set(key,[...(sourceByIdentity.get(key) ?? []),row]); }
  const tracking = (await db.query<{payroll_transaction_id:string;state:string;fingerprint:string}>(`SELECT payroll_transaction_id,state,fingerprint
    FROM sheet_sync_rows WHERE payroll_transaction_id=ANY($1::uuid[])`,[rows.map(row => row.id)])).rows;
  const result = new Map<string,{reason:string|null;rowNumbers:number[]}>(), groupCache = new Map<number,boolean>();
  for (const row of rows) {
    const next = replacement(row), original = originalParsed(row), key = sheetSourceIdentityKey(identity(row));
    const matches = key ? sourceByIdentity.get(key) ?? [] : [], records = tracking.filter(record => record.payroll_transaction_id === row.id);
    let reason:string|null = null;
    if (row.import_status !== "imported" || !row.employee_id || !row.individual_id || !row.program_id || !next || !original || exact(original.calculatedInternalAmount) !== next.base || !matches.length
      || records.length !== 1 || records[0]!.state !== "active" || records[0]!.fingerprint !== row.transaction_fingerprint
      || matches.some(sourceRow => !sourceRow.parsed || exact(sourceRow.parsed.calculatedInternalAmount) !== next.base
        || !sameMappedSource(original,sourceRow.parsed) || text(sourceRow.parsed.payTo) !== text(row.pay_to_raw)
        || resolveEmployee(sourceRow.parsed.employee).matchedId !== row.employee_id
        || resolveIndividual(sourceRow.parsed.individual).matchedId !== row.individual_id
        || !programs.some(program => program.id === row.program_id && program.code === resolveProgram(sourceRow.parsed!.programDescription,programAliases).code))) {
      reason = "Original source, current source, approved person or program match, stored rates or transaction identity disagree. Nothing was changed.";
    } else {
      let unresolved = groupCache.get(matches[0]!.sourceRowNumber);
      if (unresolved === undefined) {
        const group = sourceNetCheckGroup(source.ahivimRows,identity(row),row.employee_id,
          {employees:directory.employees.people,aliases:directory.employees.aliases,merges:directory.employees.merges});
        unresolved = group.unresolved;
        for (const rowNumber of group.rowNumbers) groupCache.set(rowNumber,unresolved);
      }
      if (unresolved) reason = "Another source row may belong to this check but its identity is unresolved. Review the group first.";
    }
    result.set(row.id,{reason,rowNumbers:matches.map(match => match.sourceRowNumber)});
  }
  return result;
}

/**
 * Repair only the demonstrated legacy retain-gross projection. Each source row
 * receives its own immutable before/after audit, grouped by one atomic request.
 * Paid, verified or posted history is deliberately outside this narrow action.
 */
export async function recoverSourceBase(
  pool: PgLikePool, input: SourceBaseRecoveryInput, actorId: string | null, options: { fetcher?: CsvFetcher } = {},
): Promise<Result<SourceBaseRecoveryResult>> {
  const reason = input.reason?.trim(), requested = [...new Set(input.transactionIds ?? [])].sort();
  if (!reason || reason.length > 2000 || !UUID.test(input.operationKey) || !SHA.test(input.sourceHash)
    || !["accept","undo"].includes(input.action)
    || (input.action === "accept" && (!requested.length || requested.length > 1000 || requested.some(id => !UUID.test(id)) || input.acceptanceAuditId))
    || (input.action === "undo" && (!UUID.test(input.acceptanceAuditId ?? "") || requested.length))) {
    return fail("validation","Choose up to 1,000 rows or a saved batch, and provide a source snapshot, reason and valid retry key.");
  }
  const requestHash = hash({action:input.action,reason,sourceHash:input.sourceHash,transactionIds:requested,acceptanceAuditId:input.acceptanceAuditId ?? null,actorId});
  const client = await pool.connect(); let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["ahivim:sheet-sync:canonical-ledger:v1"]);
    await acquireSettlementSourceLock(client);
    const result = await (async (): Promise<Result<SourceBaseRecoveryResult>> => {
      const prior = (await client.query<Audit>(`SELECT id,entity_id,action,metadata,created_at::text,reason FROM audit_logs
        WHERE action IN ($1,$2) AND metadata->>'operationKey'=$3`,[BATCH_ACCEPT,BATCH_REVERSE,input.operationKey])).rows;
      if (prior.length) {
        const audit = prior[0]!;
        if (prior.length !== 1 || audit.metadata.requestHash !== requestHash) return fail("conflict","This retry key belongs to a different request.");
        return ok({batchAuditId:audit.id,acceptanceAuditId:String(audit.metadata.acceptanceAuditId ?? audit.id),
          transactionCount:Number(audit.metadata.transactionCount),alreadyApplied:true,status:input.action === "accept" ? "accepted" : "undone"});
      }
      // These sources also have manual writers. Keep their state stable after
      // the common source lock and before reading the review/evidence snapshot.
      await client.query(`LOCK TABLE employees,employee_aliases,individuals,individual_aliases,programs,app_settings,
        program_aliases,payroll_transactions,import_rows,employee_payroll_checks,settlement_events,settlement_obligations,
        settlement_obligation_transactions,service_sessions,service_allocations,audit_logs,import_warnings,rate_exceptions
        IN SHARE ROW EXCLUSIVE MODE`);
      const scoped: PgLikePool = {query:(sql,params) => client.query(sql,params),connect:async () => {throw new Error("Nested source base recovery connection");}};
      let acceptedBatch: Audit | undefined, acceptedItems: Item[] = [];
      if (input.action === "undo") {
        acceptedBatch = (await client.query<Audit>(`SELECT id,entity_id,action,metadata,created_at::text,reason FROM audit_logs
          WHERE id=$1 AND action=$2`,[input.acceptanceAuditId,BATCH_ACCEPT])).rows[0];
        if (!acceptedBatch || !Array.isArray(acceptedBatch.metadata.items) || acceptedBatch.metadata.sourceHash !== input.sourceHash) {
          return fail("conflict","The saved batch or its original source snapshot is unavailable.");
        }
        acceptedItems = acceptedBatch.metadata.items as Item[];
        if (!acceptedItems.length || acceptedItems.length > 1000 || acceptedItems.some(item => !UUID.test(item.transactionId) || !UUID.test(item.auditId))) {
          return fail("immutable","The saved acceptance lineage is incomplete; review its audit history.");
        }
        const reversed = (await client.query(`SELECT id FROM audit_logs WHERE action=$1 AND metadata->>'acceptanceAuditId'=$2`,[BATCH_REVERSE,acceptedBatch.id])).rows;
        if (reversed.length) return fail("conflict","This batch was already undone.");
      }
      const ids = input.action === "accept" ? requested : acceptedItems.map(item => item.transactionId).sort();
      const rows = await loadRows(client,ids);
      if (rows.length !== ids.length) return fail("not_found","At least one original imported transaction is unavailable.");
      const active = (await client.query<Audit>(`SELECT a.id,a.entity_id,a.action,a.metadata,a.created_at::text,a.reason FROM audit_logs a
        WHERE a.action=$1 AND a.entity_type='payroll_transaction' AND a.entity_id=ANY($2::uuid[])
          AND NOT EXISTS(SELECT 1 FROM audit_logs r WHERE r.action=$3 AND r.metadata->>'acceptanceAuditId'=a.id::text)`,[ACCEPT,ids,REVERSE])).rows;
      if (input.action === "accept" && active.length) return fail("conflict","A selected row already has an active source-base repair. Refresh the review.");
      if (input.action === "undo" && (active.length !== rows.length || acceptedItems.some(item => !active.some(audit => audit.id === item.auditId
        && audit.entity_id === item.transactionId && audit.metadata.batchAuditId === acceptedBatch!.id
        && hash(audit.metadata.previous) === hash(item.previous)
        && hash(audit.metadata.next) === hash(item.next))))) return fail("conflict","Only the latest unreversed acceptance for every selected row can be undone.");
      const blocked = await financialReasons(client,rows);
      for (const row of rows) {
        const financial = blocked.get(row.id);
        if (financial) return fail("immutable",financial);
        if (input.action === "accept") { const reason = legacyReason(row); if (reason) return fail("immutable",reason); }
        else {
          const saved = acceptedItems.find(item => item.transactionId === row.id)!;
          if (row.other_fields_hash !== saved.otherFieldsHash || hash(row.raw_values) !== saved.originalSourceHash || hash(row.warnings) !== saved.originalWarningHash
            || hash(projection(row)) !== hash(saved.next) || row.corrected_values !== null || row.correction_status === "corrected") return fail("conflict","An accepted amount, source or payment fact changed. Review its history before Undo.");
        }
      }
      const config = await getSyncConfig(scoped);
      if (config.sheetId !== DEFAULT_SHEET_ID || config.sheetName !== DEFAULT_SHEET_NAME) return fail("conflict","Use the designated read-only Ahivim source for this repair.");
      const source = parseSheetCsv(await (options.fetcher ?? fetchSheetCsv)(config));
      if (source.snapshotSha256 !== input.sourceHash) return fail("conflict","The source changed after this preview. Sync and review its current values first.");
      const evidence = await sourceEvidence(client,rows,source);
      const items: Item[] = [];
      for (const row of rows) {
        const previous = projection(row)!, next = replacement(row)!, checked = evidence.get(row.id)!;
        if (checked.reason) return fail("conflict",checked.reason);
        const saved = acceptedItems.find(item => item.transactionId === row.id);
        items.push({transactionId:row.id,auditId:randomUUID(),previous,next:input.action === "accept" ? next : saved!.previous,
          sourceFileId:row.source_file_id,sourceRowNumber:row.source_row_number,individual:row.individual,employee:row.employee,
          originalSourceHash:hash(row.raw_values),otherFieldsHash:row.other_fields_hash,importRowId:row.import_row_id,
          originalWarningHash:hash(row.warnings),originalWarningIds:row.warnings.map(warning => warning.id),
          sourceRowNumbers:checked.rowNumbers,groupBudgetBasis:row.rate_scope === "per_group",
          appliedInternalRate:String(row.internal_rate_applied),appliedAgencyRate:String(row.agency_rate_applied)});
      }
      const batchAuditId = randomUUID(), attribution = await resolveAuditAttribution(actorId);
      const changed = await client.query<{id:string}>(`UPDATE payroll_transactions t SET calculated_internal_amount=v.base,
        employee_payment_amount=v.employee_payment,agency_additional_amount=v.agency_additional,internal_amount_mismatch=v.mismatch
        FROM jsonb_to_recordset($1::jsonb) AS v(id uuid,base numeric,employee_payment numeric,agency_additional numeric,mismatch boolean)
        WHERE t.id=v.id RETURNING t.id`,[JSON.stringify(items.map(item => ({id:item.transactionId,base:item.next.base,
          employee_payment:item.next.employeePayment,agency_additional:item.next.agencyAdditional,mismatch:item.next.mismatch})))]);
      if (changed.rows.length !== items.length) throw new Error("The source repair did not update every selected projection.");
      const auditRows = items.map(item => ({id:item.auditId,action:input.action === "accept" ? ACCEPT : REVERSE,entity_type:"payroll_transaction",entity_id:item.transactionId,
        metadata:{operationKey:input.operationKey,requestHash,batchAuditId,previous:item.previous,next:item.next,sourceHash:source.snapshotSha256,
          originalSourceHash:item.originalSourceHash,otherFieldsHash:item.otherFieldsHash,originalImportRowId:item.importRowId,sourceRowNumbers:item.sourceRowNumbers,
          originalWarningHash:item.originalWarningHash,originalWarningIds:item.originalWarningIds,originalWarningsUnchanged:true,
          appliedInternalRate:item.appliedInternalRate,appliedAgencyRate:item.appliedAgencyRate,rule:"agency_rate_converted",
          groupBudgetBasis:item.groupBudgetBasis,rateReviewUnchanged:true,
          ...(acceptedBatch ? {acceptanceAuditId:acceptedItems.find(saved => saved.transactionId === item.transactionId)!.auditId} : {}),
          ...(attribution.impersonatedUserId ? {impersonatedUserId:attribution.impersonatedUserId} : {})}}));
      const batchMetadata = {operationKey:input.operationKey,requestHash,sourceHash:source.snapshotSha256,transactionCount:items.length,
        transactionIds:ids,items,...(acceptedBatch ? {acceptanceAuditId:acceptedBatch.id} : {}),
        ...(attribution.impersonatedUserId ? {impersonatedUserId:attribution.impersonatedUserId} : {})};
      await client.query(`INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,reason,metadata)
        SELECT a.id,$2::uuid,a.action,a.entity_type,a.entity_id,$3,a.metadata
        FROM jsonb_to_recordset($1::jsonb) AS a(id uuid,action text,entity_type text,entity_id uuid,metadata jsonb)`,
      [JSON.stringify([...auditRows,{id:batchAuditId,action:input.action === "accept" ? BATCH_ACCEPT : BATCH_REVERSE,
        entity_type:"payroll_transactions",entity_id:null,metadata:batchMetadata}]),attribution.actorId,reason]);
      return ok({batchAuditId,acceptanceAuditId:acceptedBatch?.id ?? batchAuditId,transactionCount:items.length,
        alreadyApplied:false,status:input.action === "accept" ? "accepted" : "undone"});
    })();
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch(error) {
    try { await client.query("ROLLBACK"); } catch { discard=true; }
    throw error;
  } finally { client.release(discard || undefined); }
}

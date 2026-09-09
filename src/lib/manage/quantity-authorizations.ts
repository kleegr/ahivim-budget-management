import type { PgLikePool } from "@/lib/import/commit";
import { isIsoCalendarDate } from "@/lib/business/class-invoicing";
import { agencyDate } from "@/lib/business/agency-time";
import { dec, tryDec } from "@/lib/money";
import { fail, ok, type Result } from "./errors";
import { recordChange } from "./audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface QuantityAuthorization {
 id: string; individualId: string; programId: string; programName: string; unitLabel: string;
 authorized: string; used: string; remaining: string; startDate: string; endDate: string; revision: number;
 events: { id: string; serviceDate: string; quantity: string; evidence: string; reason: string; reversesEventId: string | null }[];
 revisions: { revision: number; reason: string; snapshot: Record<string, unknown> }[];
}

export async function listQuantityAuthorizations(pool: Pick<PgLikePool, "query">, individualId: string): Promise<QuantityAuthorization[]> {
 // One statement supplies the balance and both histories from the same MVCC
 // snapshot, including when another operator records usage during this read.
 const { rows } = await pool.query<{ id: string; individual_id: string; program_id: string; name: string; unit_label: string; authorized_quantity: string; used: string; start_date: string; end_date: string; revision: number; events: QuantityAuthorization["events"]; revisions: QuantityAuthorization["revisions"] }>(`
 SELECT a.id, a.individual_id, a.program_id, p.name, a.unit_label, a.authorized_quantity::text,
 a.start_date::text, a.end_date::text, a.revision, COALESCE(usage.used,0)::text AS used,
 COALESCE(usage.events,'[]'::jsonb) AS events,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',r.revision,'reason',r.reason,'snapshot',r.snapshot) ORDER BY r.revision DESC)
   FROM quantity_authorization_revisions r WHERE r.authorization_id = a.id),'[]'::jsonb) AS revisions
 FROM quantity_authorizations a JOIN programs p ON p.id = a.program_id
 LEFT JOIN LATERAL (
  SELECT sum(e.quantity) AS used,
   jsonb_agg(jsonb_build_object('id',e.id,'serviceDate',e.service_date::text,'quantity',e.quantity::text,
    'evidence',e.evidence_reference,'reason',e.reason,'reversesEventId',e.reverses_event_id)
    ORDER BY e.service_date DESC,e.id DESC) AS events
  FROM quantity_usage_events e WHERE e.authorization_id = a.id
 ) usage ON true
 WHERE a.individual_id = $1 ORDER BY a.start_date DESC, a.id`, [individualId]);
 return rows.map(row => ({ id: row.id, individualId: row.individual_id, programId: row.program_id, programName: row.name,
  unitLabel: row.unit_label, authorized: row.authorized_quantity, used: row.used, remaining: dec(row.authorized_quantity).minus(row.used).toFixed(4),
  startDate: row.start_date, endDate: row.end_date, revision: row.revision,
  events: row.events,
  revisions: row.revisions,
 }));
}

export async function changeQuantityAuthorization(pool: PgLikePool, individualId: string, input: Record<string, unknown>, actorId: string, options: { asOf?: string } = {}): Promise<Result<{ id: string }>> {
 const allowed = new Set(["action", "requestId", "id", "programId", "unitLabel", "authorized", "startDate", "endDate", "expectedRevision", "serviceDate", "quantity", "evidence", "reason", "eventId"]);
 if (Object.keys(input).some(key => !allowed.has(key))) return fail("forbidden", "Only non-money quantity fields are allowed.");
 const action = String(input.action ?? "");
 if (!["create", "revise", "consume", "reverse"].includes(action)) return fail("validation", "Choose an authorization or usage action.");
 const requestId = String(input.requestId ?? ""); const id = String(input.id ?? "");
 const reason = String(input.reason ?? "").trim();
 if (!UUID.test(individualId) || !UUID.test(requestId) || (action !== "create" && !UUID.test(id))) return fail("validation", "Invalid authorization identity.");
 if (reason.length < 5) return fail("validation", "Give a reason with at least five characters.");
 const client = await pool.connect();
 try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`quantity:${individualId}`]);
  const retry = await client.query<{ entity_id: string; metadata: { request: string } }>("SELECT entity_id, metadata FROM audit_logs WHERE action = 'quantity_changed' AND metadata->>'requestId' = $1", [requestId]);
  const request = JSON.stringify({ input, individualId, actorId });
  if (retry.rows[0]) {
   if (retry.rows[0].metadata.request !== request) { await client.query("ROLLBACK"); return fail("conflict", "That request saved different values."); }
   await client.query("COMMIT"); return ok({ id: retry.rows[0].entity_id });
  }
  let targetId = id;
  const before = action === "create" ? null : (await client.query<{ id: string; program_id: string; unit_label: string; revision: number; start_date: string; end_date: string }>("SELECT *, start_date::text, end_date::text FROM quantity_authorizations WHERE id = $1 AND individual_id = $2 FOR UPDATE", [id, individualId])).rows[0];
  if (action !== "create" && !before) { await client.query("ROLLBACK"); return fail("not_found", "That quantity authorization was not found."); }
  if (before && before.revision !== Number(input.expectedRevision)) { await client.query("ROLLBACK"); return fail("conflict", "This authorization changed. Reload its current revision."); }
  if (action === "create" || action === "revise") {
   const programId = before?.program_id ?? String(input.programId ?? "");
   const unit = String(input.unitLabel ?? "").trim(); const amount = tryDec(String(input.authorized ?? ""));
   const start = String(input.startDate ?? ""); const end = String(input.endDate ?? "");
   if (!UUID.test(programId) || !/^[\p{L}][\p{L} .-]{0,39}$/u.test(unit) || /^(hours?|dollars?|usd|euros?|gbp|cad|ils|money)$/i.test(unit) || !amount || amount.lt(0) || amount.gte("1000000000000") || amount.decimalPlaces() > 4 || !isIsoCalendarDate(start) || !isIsoCalendarDate(end) || end < start) {
    await client.query("ROLLBACK"); return fail("validation", "Enter a non-money unit, nonnegative quantity (up to four decimals), and valid authorization dates.");
   }
   const program = await client.query("SELECT id FROM programs WHERE id = $1 AND is_active", [programId]);
   if (!program.rows.length) { await client.query("ROLLBACK"); return fail("validation", "Choose an active program."); }
   const overlaps = await client.query(`SELECT id FROM quantity_authorizations WHERE individual_id = $1 AND program_id = $2 AND lower(unit_label) = lower($3) AND start_date <= $5::date AND end_date >= $4::date AND id <> $6::uuid`, [individualId, programId, unit, start, end, before?.id ?? "00000000-0000-0000-0000-000000000000"]);
   if (overlaps.rows.length) { await client.query("ROLLBACK"); return fail("conflict", "An authorization for this program and unit already covers these dates. Revise it instead."); }
   if (before) {
    const usage = await client.query("SELECT id FROM quantity_usage_events WHERE authorization_id = $1 AND (service_date < $2::date OR service_date > $3::date OR $4 <> $5) LIMIT 1", [id, start, end, unit, before.unit_label]);
    if (usage.rows.length) { await client.query("ROLLBACK"); return fail("conflict", "Existing usage must remain within its original unit and authorization dates."); }
    await client.query("INSERT INTO quantity_authorization_revisions (authorization_id,revision,snapshot,reason,created_by_user_id) VALUES ($1,$2,$3,$4,$5)", [id,before.revision,JSON.stringify(before),reason,actorId]);
    await client.query("UPDATE quantity_authorizations SET unit_label=$2, authorized_quantity=$3, start_date=$4, end_date=$5, revision=revision+1, updated_at=now() WHERE id=$1", [id,unit,amount.toFixed(4),start,end]);
   } else {
    const inserted = await client.query<{ id: string }>("INSERT INTO quantity_authorizations (individual_id,program_id,unit_label,authorized_quantity,start_date,end_date,created_by_user_id,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [individualId,programId,unit,amount.toFixed(4),start,end,actorId,requestId]);
    targetId = inserted.rows[0]!.id;
   }
  } else if (before) {
   let quantity = tryDec(String(input.quantity ?? "")); let serviceDate = String(input.serviceDate ?? ""); let evidence = String(input.evidence ?? "").trim();
   let reversesId: string | null = null;
   if (action === "reverse") {
    const original = await client.query<{ id: string; quantity: string; service_date: string; evidence_reference: string }>("SELECT id,quantity::text,service_date::text,evidence_reference FROM quantity_usage_events WHERE id=$1 AND authorization_id=$2 AND reverses_event_id IS NULL", [UUID.test(String(input.eventId)) ? input.eventId : null,id]);
    if (!original.rows[0]) { await client.query("ROLLBACK"); return fail("not_found", "Choose an original usage record."); }
    reversesId=original.rows[0].id; quantity=dec(original.rows[0].quantity).negated(); serviceDate=original.rows[0].service_date; evidence=original.rows[0].evidence_reference;
    if ((await client.query("SELECT id FROM quantity_usage_events WHERE reverses_event_id=$1", [reversesId])).rows.length) { await client.query("ROLLBACK"); return fail("conflict", "That usage already has a reversal."); }
   }
   if (!quantity || (!reversesId && quantity.lte(0)) || quantity.abs().gte("1000000000000") || quantity.decimalPlaces()>4 || !isIsoCalendarDate(serviceDate) || serviceDate<before.start_date || serviceDate>before.end_date || evidence.length<3) {
    await client.query("ROLLBACK"); return fail("validation", "Enter a positive completed quantity, evidence reference, and service date within this authorization.");
   }
   if (!reversesId && serviceDate > (options.asOf ?? agencyDate())) {
    await client.query("ROLLBACK"); return fail("validation", "Completed quantity cannot use a future service date.");
   }
   await client.query("INSERT INTO quantity_usage_events (authorization_id,service_date,quantity,evidence_reference,reverses_event_id,reason,created_by_user_id,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id,serviceDate,quantity.toFixed(4),evidence,reversesId,reason,actorId,requestId]);
  }
  await recordChange(client,{ actorId,action:"quantity_changed",entityType:"quantity_authorization",entityId:targetId,reason,extra:{requestId,request},previous:before,next:input });
  await client.query("COMMIT"); return ok({id:targetId});
 } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; } finally {client.release();}
}

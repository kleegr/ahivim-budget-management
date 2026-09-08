import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";
import { listSourceBaseRecoveryReview as loadReview, recoverSourceBase, type SourceBaseRecoveryInput } from "@/lib/sheets/base-recovery";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { runSheetSync } from "@/lib/sheets/sync";
import { createProgramBudget } from "@/lib/manage/program-budgets";
import { listProgramBudgets } from "@/lib/data/program-budgets";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;
let fixtureSource = "";
const listSourceBaseRecoveryReview = (pool:PgLikePool) => loadReview(pool,{fetcher:async () => fixtureSource});
suite("Audited repair of historical agency base projections", () => {
  beforeEach(resetSchema,60_000);
  afterAll(closeTestPool);

  async function setup(edit?: (values:string[][]) => void) {
    const pool = testPool(), fixture = await numericSheetFixture();
    const values = fixture.values.map(row => [...row]);
    values.push([...values[3]!]);
    for (const [index,row] of values.slice(3).entries()) {
      row[0] = "Excellent Staffing"; row[2] = `BASE-RECOVERY-${index}`;
      row[4] = "4"; row[5] = "25"; row[6] = index === 1 ? "200" : "100";
      row[7] = ""; row[10] = "Com Hab"; row[15] = index === 1 ? "168" : "84";
    }
    edit?.(values);
    const csv = sheetValuesToCsv(values), sourceHash = parseSheetCsv(csv).snapshotSha256;
    fixtureSource = csv;
    expect(await runSheetSync(pool,{trigger:"manual",userId:null,config:DEFAULT_SYNC_CONFIG,fetcher:async () => csv}))
      .toMatchObject({status:"success",added:3});
    // Reproduce the previously imported retain-gross bug without changing
    // immutable original Sheet P, stored applied rates or source tracking.
    await pool.query(`UPDATE payroll_transactions SET calculated_internal_amount=imported_amount,
      employee_payment_amount=imported_amount,agency_additional_amount=0,internal_amount_mismatch=true`);
    await pool.query(`INSERT INTO import_warnings(import_batch_id,import_row_id,category,severity,message,details)
      SELECT i.import_batch_id,i.id,'internal_amount_mismatch','warning','Original calculation disagreement',
        jsonb_build_object('application',t.imported_amount::text,'spreadsheet',t.spreadsheet_internal_amount::text,
          'difference',(t.imported_amount-t.spreadsheet_internal_amount)::text)
      FROM payroll_transactions t JOIN import_rows i ON i.id=t.import_row_id`);
    await pool.query(`UPDATE payroll_transactions SET is_paid=true,paid_at=now() WHERE check_number='BASE-RECOVERY-2'`);
    const ids = (await pool.query<{id:string}>(`SELECT id FROM payroll_transactions WHERE NOT is_paid ORDER BY id`)).rows.map(row => row.id);
    const action = (input:Partial<SourceBaseRecoveryInput> = {}, source=csv, db:PgLikePool=pool) => recoverSourceBase(db,{
      action:"accept",reason:"Original source and recorded rate pair prove the historical calculation error",
      operationKey:randomUUID(),sourceHash,transactionIds:ids,...input,
    },null,{fetcher:async () => source});
    return {pool,csv,values,sourceHash,ids,action};
  }
  async function controls() {
    return (await testPool().query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t)-ARRAY['calculated_internal_amount','internal_amount_mismatch','employee_payment_amount','agency_additional_amount'] ORDER BY id) FROM payroll_transactions t) AS other_transaction_fields,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM import_rows t) AS source,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sheet_sync_rows t) AS tracking,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM import_warnings t) AS warnings,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM rate_exceptions t) AS rate_exceptions,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM employee_payroll_checks t) AS checks,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_obligations t) AS obligations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_events t) AS events,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM service_allocations t) AS allocations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM service_sessions t) AS sessions,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM budget_authorizations t) AS authorizations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM budget_periods t) AS periods`)).rows[0];
  }
  async function allMutable() {
    return (await testPool().query(`SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payroll_transactions t) AS payroll,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM audit_logs t) AS audit,
      (SELECT jsonb_agg(to_jsonb(t)) FROM settlement_ledger_state t) AS freshness`)).rows[0];
  }

  it("previews two exact eligible rows and a Paid hold, accepts atomically, retries and undoes the complete four-field batch",async () => {
    const {pool,action,ids,csv} = await setup();
    const before = await controls(), original = await allMutable();
    const preview = await listSourceBaseRecoveryReview(pool);
    expect(preview.candidates.filter(row => row.eligible)).toHaveLength(2);
    expect(preview.candidates.find(row => row.paid)).toMatchObject({eligible:false,reviewReason:expect.stringContaining("Paid")});
    const operationKey = randomUUID(), accepted = await action({operationKey});
    if (!accepted.ok) throw new Error("Concurrent acceptance failed");
    expect(accepted.data).toMatchObject({transactionCount:2,status:"accepted",alreadyApplied:false});
    expect(await controls()).toEqual(before);
    expect((await pool.query(`SELECT calculated_internal_amount,employee_payment_amount,agency_additional_amount,internal_amount_mismatch
      FROM payroll_transactions WHERE id=ANY($1::uuid[]) ORDER BY imported_amount`,[ids])).rows).toEqual([
      {calculated_internal_amount:"84.0000",employee_payment_amount:"84.0000",agency_additional_amount:"16.0000",internal_amount_mismatch:false},
      {calculated_internal_amount:"168.0000",employee_payment_amount:"168.0000",agency_additional_amount:"32.0000",internal_amount_mismatch:false},
    ]);
    const saved = await allMutable();
    expect(await action({operationKey})).toMatchObject({ok:true,data:{alreadyApplied:true}});
    expect(await allMutable()).toEqual(saved);
    expect(await action({operationKey,reason:"Different request"})).toMatchObject({ok:false,code:"conflict"});
    expect(await runSheetSync(pool,{trigger:"manual",userId:null,config:DEFAULT_SYNC_CONFIG,fetcher:async () => csv})).toMatchObject({status:"no_changes",added:0,changed:0});
    const history = (await listSourceBaseRecoveryReview(pool)).history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({canUndo:true,previousTotals:{base:"300.0000",employeePayment:"300.0000",agencyAdditional:"0.0000"},nextTotals:{base:"252.0000",employeePayment:"252.0000",agencyAdditional:"48.0000"}});
    const undo = {action:"undo" as const,transactionIds:undefined,acceptanceAuditId:accepted.data.acceptanceAuditId,operationKey:randomUUID()};
    expect(await action(undo)).toMatchObject({ok:true,data:{status:"undone",transactionCount:2}});
    expect((await allMutable())!.payroll).toEqual(original!.payroll);
    expect(await controls()).toEqual(before);
    const undone = await allMutable();
    expect(await action(undo)).toMatchObject({ok:true,data:{alreadyApplied:true}});
    expect(await allMutable()).toEqual(undone);
    expect((await listSourceBaseRecoveryReview(pool)).history[0]).toMatchObject({canUndo:false,reversalAuditId:expect.any(String)});
  },40_000);

  it("serializes concurrent retries and acknowledges a lost commit response without another write",async () => {
    const {pool,action,csv} = await setup();
    const operationKey = randomUUID();
    const results = await Promise.all([action({operationKey}),action({operationKey})]);
    expect(results.filter(result => result.ok && !result.data.alreadyApplied)).toHaveLength(1);
    expect(results.filter(result => result.ok && result.data.alreadyApplied)).toHaveLength(1);
    const accepted = results.find(result => result.ok)!;
    if (!accepted.ok) throw new Error("Concurrent acceptance failed");
    const undoKey = randomUUID();
    const disconnected:PgLikePool = {query:(sql,args) => pool.query(sql,args),connect:async () => {
      const client = await pool.connect();
      return {query:async <T>(sql:string,args?:unknown[]) => {const result = await client.query<T>(sql,args);
        if (sql === "COMMIT") throw new Error("Response was lost after commit"); return result;},release:error => client.release(error)};
    }};
    const undo = {action:"undo" as const,transactionIds:undefined,acceptanceAuditId:accepted.data.acceptanceAuditId,operationKey:undoKey};
    await expect(action(undo,csv,disconnected)).rejects.toThrow("Response was lost");
    const beforeRetry = await allMutable();
    expect(await action(undo)).toMatchObject({ok:true,data:{alreadyApplied:true,status:"undone"}});
    expect(await allMutable()).toEqual(beforeRetry);
  },40_000);

  it("holds source drift even with a replacement preview hash and keeps every field and audit unchanged",async () => {
    const {action,values} = await setup();
    for (const [column,value] of [[15,"83"],[0,"A different payee"],[7,"123.45"],[6,"100.01"],[12,"Unknown employee"],[11,"Unknown individual"],[10,"Respite"]] as const) {
      const edited = values.map(row => [...row]); edited[3]![column]=value;
      const csv = sheetValuesToCsv(edited), before = await allMutable();
      expect(await action({sourceHash:parseSheetCsv(csv).snapshotSha256},csv)).toMatchObject({ok:false});
      expect(await allMutable()).toEqual(before);
    }
  },40_000);

  it("keeps original candidates visible but ineligible when current source verification fails",async () => {
    const {pool} = await setup();
    const review = await loadReview(pool,{fetcher:async () => {throw new Error("Synthetic source unavailable");}});
    expect(review).toMatchObject({sourceHash:null,reviewReason:expect.stringContaining("could not be verified")});
    expect(review.candidates).toHaveLength(3);
    expect(review.candidates.every(row => !row.eligible && row.reviewReason)).toBe(true);
  },40_000);

  it("holds a concurrent manual Paid writer until the source acceptance commits, then refuses Undo",async () => {
    const {pool,ids,sourceHash,csv} = await setup();
    let enter!:() => void, resume!:() => void;
    const entered = new Promise<void>(resolve => {enter=resolve;}), releaseSource = new Promise<void>(resolve => {resume=resolve;});
    const action = recoverSourceBase(pool,{action:"accept",reason:"Reviewed exact historical source",operationKey:randomUUID(),sourceHash,transactionIds:ids},null,
      {fetcher:async () => {enter();await releaseSource;return csv;}});
    await entered;
    const writer = await pool.connect();
    let update:Promise<unknown>|undefined;
    try {
      const pid = (await writer.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      update = writer.query("UPDATE payroll_transactions SET is_paid=true,paid_at=now() WHERE id=$1",[ids[0]]);
      let waiting = false;
      for (let attempt=0;attempt<30 && !waiting;attempt++) {
        waiting = (await pool.query<{waiting:boolean}>("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      resume();
      const accepted = await action; if (!accepted.ok) throw new Error(accepted.message);
      await update;
      const beforeUndo = await allMutable();
      expect(await recoverSourceBase(pool,{action:"undo",reason:"Audited reversal requested",operationKey:randomUUID(),sourceHash,acceptanceAuditId:accepted.data.acceptanceAuditId},null,{fetcher:async () => csv}))
        .toMatchObject({ok:false,code:"immutable",message:expect.stringContaining("Paid")});
      expect(await allMutable()).toEqual(beforeUndo);
      expect((await listSourceBaseRecoveryReview(pool)).history[0]).toMatchObject({canUndo:false,undoReviewReason:expect.stringContaining("Paid")});
    } finally {resume();await action;await update;writer.release();}
  },40_000);

  it("shows a corrected source change for review without creating a replacement transaction or erasing the accepted projection",async () => {
    const {pool,action,values,ids} = await setup();
    const accepted = await action(); if (!accepted.ok) throw new Error(accepted.message);
    const before = await allMutable();
    const changed = values.map(row => [...row]);changed[3]![4]="5";changed[3]![6]="125";changed[3]![15]="105";
    const csv = sheetValuesToCsv(changed);
    const sync = () => runSheetSync(pool,{trigger:"manual",userId:null,config:DEFAULT_SYNC_CONFIG,fetcher:async () => csv});
    expect(await sync()).toMatchObject({status:"success",added:0,changed:1});
    expect(await sync()).toMatchObject({status:"no_changes",added:0,changed:0});
    // Sync updates review/freshness markers; every recorded source/money field
    // and the accepted four-field projection remains unchanged.
    const amounts = (rows:unknown) => (rows as Record<string,unknown>[]).map(({sync_review_reason: _review,updated_at: _updated,...row}) => row);
    expect(amounts((await allMutable())!.payroll)).toEqual(amounts(before!.payroll));
    expect((await pool.query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]).toEqual({count:3});
    expect((await pool.query("SELECT payroll_transaction_id FROM sheet_sync_conflicts WHERE status='open'")).rows[0]?.payroll_transaction_id).toBeOneOf(ids);
    expect(await action({action:"undo",transactionIds:undefined,acceptanceAuditId:accepted.data.acceptanceAuditId})).toMatchObject({ok:false});
  },40_000);

  for (const [label,sql] of [
    ["stored rates","UPDATE payroll_transactions SET internal_rate_applied=20 WHERE id=$1"],
    ["payment projection","UPDATE payroll_transactions SET employee_payment_amount=99 WHERE id=$1"],
    ["spread projection","UPDATE payroll_transactions SET agency_additional_amount=1 WHERE id=$1"],
    ["routing","UPDATE payroll_transactions SET payment_recipient='employee_direct' WHERE id=$1"],
    ["reviewed warning","UPDATE import_warnings SET resolved_at=now() WHERE import_row_id=(SELECT import_row_id FROM payroll_transactions WHERE id=$1)"],
    ["corrected source","UPDATE import_rows SET corrected_values='{}' WHERE id=(SELECT import_row_id FROM payroll_transactions WHERE id=$1)"],
    ["uncommitted review status","UPDATE import_rows SET status='needs_review' WHERE id=(SELECT import_row_id FROM payroll_transactions WHERE id=$1)"],
    ["source identity","UPDATE sheet_sync_rows SET fingerprint='changed' WHERE payroll_transaction_id=$1"],
    ["canonical program","UPDATE payroll_transactions SET program_id=(SELECT id FROM programs WHERE code='RESPITE') WHERE id=$1"],
  ]) {
    it(`holds ${label} changes without a partial batch`,async () => {
      const {pool,ids,action} = await setup();
      await pool.query(sql!,[ids[0]]); const before = await allMutable();
      expect(await action()).toMatchObject({ok:false});
      expect(await allMutable()).toEqual(before);
    },40_000);
  }

  it("preserves a separately audited override even if its amount still resembles the historical error",async () => {
    const {pool,ids,action} = await setup();
    await pool.query(`INSERT INTO audit_logs(action,entity_type,entity_id,reason,metadata)
      VALUES ('transaction_corrected','payroll_transaction',$1,'Recorded prior review','{}')`,[ids[0]]);
    const before = await allMutable();
    expect(await action()).toMatchObject({ok:false,code:"immutable"});
    expect(await allMutable()).toEqual(before);
  },40_000);

  it("requires latest exact acceptance lineage and refuses Undo after a derived, source or Paid change",async () => {
    const {pool,ids,action} = await setup();
    const accepted = await action(); if (!accepted.ok) throw new Error(accepted.message);
    const undo = {action:"undo" as const,transactionIds:undefined,acceptanceAuditId:accepted.data.acceptanceAuditId};
    await pool.query("UPDATE payroll_transactions SET employee_payment_amount=83 WHERE id=$1",[ids[0]]);
    const before = await allMutable();
    expect(await action(undo)).toMatchObject({ok:false,code:"conflict"});
    expect(await allMutable()).toEqual(before);
    expect((await listSourceBaseRecoveryReview(pool)).history[0]).toMatchObject({canUndo:false,previousTotals:{base:"300.0000"},items:expect.arrayContaining([expect.objectContaining({transactionId:ids[0],sourceFileId:expect.any(String),importRowId:expect.any(String)})])});
  },40_000);

  it("allows differing per-row bases on the same unverified check and retains exact four-decimal source values",async () => {
    const {pool,action} = await setup(values => {values[4]![2]=values[3]![2]!;values[3]![6]="100.0001";values[3]![15]="84.0001";});
    expect(await action()).toMatchObject({ok:true,data:{transactionCount:2}});
    expect((await pool.query("SELECT calculated_internal_amount FROM payroll_transactions WHERE imported_amount=100.0001")).rows[0])
      .toEqual({calculated_internal_amount:"84.0001"});
  },40_000);

  it("preserves an explicit exact zero source base when the recorded rate calculation rounds to zero",async () => {
    const {pool,action} = await setup(values => {values[3]![6]="0.0001";values[3]![15]="0";});
    await pool.query("UPDATE payroll_transactions SET internal_rate_applied=1,agency_rate_applied=100 WHERE imported_amount=0.0001");
    expect(await action()).toMatchObject({ok:true});
    expect((await pool.query("SELECT calculated_internal_amount,employee_payment_amount,agency_additional_amount FROM payroll_transactions WHERE imported_amount=0.0001")).rows[0])
      .toEqual({calculated_internal_amount:"0.0000",employee_payment_amount:"0.0000",agency_additional_amount:"0.0001"});
  },40_000);

  it("keeps original/current high-precision source P exact while projecting the established four-decimal amount",async () => {
    const {pool,action} = await setup(values => {values[3]![10]="Day Hab";values[3]![5]="$ 18.00";values[3]![6]="$ 52.02";values[3]![7]="$ 1,803.10";values[3]![15]="46.54421053";});
    const accepted = await action(); expect(accepted).toMatchObject({ok:true});
    expect((await pool.query("SELECT calculated_internal_amount,employee_payment_amount,agency_additional_amount FROM payroll_transactions WHERE imported_amount=52.02")).rows[0])
      .toEqual({calculated_internal_amount:"46.5442",employee_payment_amount:"46.5442",agency_additional_amount:"5.4758"});
    expect((await pool.query("SELECT metadata FROM audit_logs WHERE action='source_base_recovery_accepted' AND metadata->>'originalSourceBase'='46.54421053'")).rows[0])
      .toMatchObject({metadata:{originalSourceBase:"46.54421053",currentSourceBases:["46.54421053"],projectionScale:4}});
  },40_000);

  it("holds distinct original/current P values even when both round to the same stored amount",async () => {
    const {action,values} = await setup(values => {values[3]![15]="84.00001";});
    const changed=values.map(row=>[...row]);changed[3]![15]="84.00002";
    const csv=sheetValuesToCsv(changed);
    const before = await allMutable();
    expect(await action({sourceHash:parseSheetCsv(csv).snapshotSha256},csv)).toMatchObject({ok:false});
    expect(await allMutable()).toEqual(before);
  },40_000);

  it("holds a source value across the four-decimal rounding boundary when stored-rate calculation disagrees",async () => {
    const {action} = await setup(values=>{values[3]![15]="84.00005";});
    const before=await allMutable();expect(await action()).toMatchObject({ok:false});expect(await allMutable()).toEqual(before);
  },40_000);

  it("accepts and undoes duplicate occurrence helper variation while preserving exact source NET and P",async () => {
    const {pool,action} = await setup(values=>{values[3]![7]="123.45";values[3]![18]="123.45";
      const repeated=[...values[3]!];repeated[18]="0";values.push(repeated);});
    const before=await controls(),accepted=await action();if(!accepted.ok)throw new Error(accepted.message);
    expect(await controls()).toEqual(before);
    expect((await pool.query("SELECT metadata FROM audit_logs WHERE action='source_base_recovery_accepted' AND metadata->>'originalDedupNetHelper'='123.45'")).rows[0])
      .toMatchObject({metadata:{originalDedupNetHelper:"123.45",currentDedupNetHelpers:["123.45","0"]}});
    expect(await action({action:"undo",transactionIds:undefined,acceptanceAuditId:accepted.data.acceptanceAuditId})).toMatchObject({ok:true});
    expect(await controls()).toEqual(before);
  },40_000);

  for (const change of ["net","base","single_helper","no_original_helper"] as const) {
    it(`holds ${change} drift despite otherwise matching duplicate source identity`,async () => {
      const {action,values}=await setup(values=>{values[3]![7]="123.45";values[3]![18]="123.45";
        if(change!=="single_helper"){const repeat=[...values[3]!];repeat[18]="0";values.push(repeat);}});
      const changed=values.map(row=>[...row]);
      if(change==="net")changed[6]![7]="123.46";
      if(change==="base")changed[6]![15]="84.00001";
      if(change==="single_helper"||change==="no_original_helper")changed[3]![18]="0";
      const csv=sheetValuesToCsv(changed),before=await allMutable();
      expect(await action({sourceHash:parseSheetCsv(csv).snapshotSha256},csv)).toMatchObject({ok:false});
      expect(await allMutable()).toEqual(before);
    },40_000);
  }

  it("records the real per-group fallback budget change while preserving allocations, authorization and source history",async () => {
    const {pool,action,ids} = await setup(values => {values[3]![10]="Day Hab";values[3]![5]="19";values[3]![6]="95";values[3]![15]="85";});
    const target = (await pool.query<{id:string;individual_id:string;program_id:string}>(`SELECT id,individual_id,program_id FROM payroll_transactions WHERE program_raw='Day Hab'`)).rows[0]!;
    const actor = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name,password_hash,role) VALUES($1,'base-budget@example.test','Budget test operator','x','admin')",[actor]);
    const created = await createProgramBudget(pool,{individualId:target.individual_id,programId:target.program_id,renewalDate:"2027-01-01",authorizedHours:"100",internalRate:"17"},actor);
    if (!created.ok) throw new Error(created.message);
    const before = await controls();
    const previous = (await listProgramBudgets(pool,{individualId:target.individual_id})).find(row => row.programId===target.program_id)!;
    expect(previous.consumedHours).toBe("5.5882");
    expect((await listSourceBaseRecoveryReview(pool)).candidates.find(row => row.transactionId===target.id)).toMatchObject({eligible:true,groupBudgetBasis:true});
    const accepted = await action({transactionIds:ids}); if (!accepted.ok) throw new Error(accepted.message);
    expect((await listProgramBudgets(pool,{individualId:target.individual_id})).find(row => row.programId===target.program_id)).toMatchObject({consumedHours:"5.0000",remainingHours:"95.0000"});
    expect(await controls()).toEqual(before);
    expect((await listSourceBaseRecoveryReview(pool)).history[0]).toMatchObject({groupBudgetBasisCount:1});
    expect(await action({action:"undo",transactionIds:undefined,acceptanceAuditId:accepted.data.acceptanceAuditId})).toMatchObject({ok:true});
    expect((await listProgramBudgets(pool,{individualId:target.individual_id})).find(row => row.programId===target.program_id)).toEqual(previous);
    expect(await controls()).toEqual(before);
  },40_000);

  it("preserves confirmed individual group-hour credit despite correcting the row's financial base",async () => {
    const {pool,action} = await setup(values => {values[3]![10]="Day Hab";values[3]![5]="19";values[3]![6]="95";values[3]![15]="85";});
    const id = (await pool.query<{id:string}>("SELECT id FROM payroll_transactions WHERE program_raw='Day Hab'")).rows[0]!.id;
    await pool.query(`UPDATE service_sessions SET group_size=2,group_detection_status='confirmed'
      WHERE id IN(SELECT service_session_id FROM service_allocations WHERE payroll_transaction_id=$1)`,[id]);
    const before = await controls();
    const hours = () => pool.query("SELECT canonical_budget_transaction_hours(t,17)::numeric(14,4)::text AS hours FROM payroll_transactions t WHERE id=$1",[id]);
    expect((await hours()).rows[0]).toEqual({hours:"4.0000"});
    expect(await action()).toMatchObject({ok:true});
    expect((await hours()).rows[0]).toEqual({hours:"4.0000"});
    expect(await controls()).toEqual(before);
  },40_000);
});

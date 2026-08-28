import {
  getProgramBudget,
  getProgramBudgetEvent,
  type ProgramBudgetEventRecord,
  type ProgramBudgetRecord,
} from "@/lib/data/program-budgets";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec, toHours, toMoney, tryDec } from "@/lib/money";
import { createAuthorizationInTransaction, createBudgetPeriod } from "./authorizations";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_TYPE = /^[a-z][a-z0-9_-]{0,39}$/;

function clientPool(client: PgLikeClient): PgLikePool {
  return {
    query: client.query.bind(client),
    connect: async () => client,
  };
}

export interface CreateProgramBudgetInput {
  individualId: string;
  programId: string;
  label?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  periodType?: string | null;
  year?: string | number | null;
  renewalDate?: string | null;
  authorizedHours?: string | number | null;
  authorizedDollars?: string | number | null;
  internalRate?: string | number | null;
  agencyRate?: string | number | null;
  individualRateOverride?: string | number | null;
  rateBasis?: string | null;
  notes?: string | null;
}

/** Create a period and its first program authorization as one transaction. */
export async function createProgramBudget(
  pool: PgLikePool,
  input: CreateProgramBudgetInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<ProgramBudgetRecord>> {
  if (!UUID.test(input.individualId) || !UUID.test(input.programId)) {
    return fail("validation", "Choose an individual and a program.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = clientPool(client);
    const period = await createBudgetPeriod(
      tx,
      {
        individualId: input.individualId,
        label: input.label ?? "",
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        periodType: input.periodType ?? null,
        year: input.year ?? null,
        renewalDate: input.renewalDate ?? null,
        notes: input.notes ?? null,
        source: "program_budget",
      },
      actorId,
      reason,
    );
    if (!period.ok) {
      await client.query("ROLLBACK");
      return period;
    }

    const authorization = await createAuthorizationInTransaction(
      client,
      {
        budgetPeriodId: period.data.id,
        programId: input.programId,
        authorizedHours: input.authorizedHours === undefined || input.authorizedHours === null
          ? null
          : String(input.authorizedHours),
        authorizedDollars: input.authorizedDollars === undefined || input.authorizedDollars === null
          ? null
          : String(input.authorizedDollars),
        ...(input.internalRate !== undefined
          ? { internalRate: input.internalRate === null ? null : String(input.internalRate) }
          : {}),
        ...(input.agencyRate !== undefined
          ? { agencyRate: input.agencyRate === null ? null : String(input.agencyRate) }
          : {}),
        ...(input.individualRateOverride !== undefined
          ? {
              individualRateOverride: input.individualRateOverride === null
                ? null
                : String(input.individualRateOverride),
            }
          : {}),
        rateBasis: input.rateBasis ?? null,
        notes: input.notes ?? null,
        source: "program_budget",
      },
      actorId,
      reason,
    );
    if (!authorization.ok) {
      await client.query("ROLLBACK");
      return authorization;
    }

    const budget = await getProgramBudget(tx, period.data.id, input.programId);
    if (!budget) throw new Error("Created program budget could not be read back.");
    await client.query("COMMIT");
    return ok(budget);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface CreateProgramBudgetEventInput {
  budgetPeriodId: string;
  programId: string;
  eventType?: "consume" | "adjust";
  serviceDate: string;
  hours?: string | number | null;
  amount?: string | number | null;
  sourceType?: string | null;
  sourceId: string;
  note?: string | null;
  overBudgetOverrideReason?: string | null;
}

interface EventAccountRow {
  program_code: string;
  individual_id: string;
  start_date: string;
  end_date: string;
  period_status: string;
  required_auth_type: "hours" | "dollars" | "both";
  consumption_source: "payroll" | "invoice" | "manual" | "mixed";
}

function normalizedEventValues(
  input: CreateProgramBudgetEventInput,
  authType: EventAccountRow["required_auth_type"],
): Result<{ hours: string; amount: string; sourceType: string; sourceId: string; note: string | null }> {
  const sourceType = input.sourceType?.trim().toLowerCase() || "manual";
  const sourceId = input.sourceId?.trim() || "";
  if (!SOURCE_TYPE.test(sourceType)) {
    return fail("validation", "The event source type may use lowercase letters, numbers, dashes, and underscores.");
  }
  if (!sourceId || sourceId.length > 200) {
    return fail("validation", "Give the event a stable source ID so retries cannot post it twice.");
  }
  const hours = tryDec(input.hours ?? "0");
  const amount = tryDec(input.amount ?? "0");
  if (!hours) return fail("validation", "Enter valid service hours.");
  if (!amount) return fail("validation", "Enter a valid service amount.");
  const eventType = input.eventType ?? "consume";
  if (eventType === "consume" && (hours.lt(0) || amount.lt(0) || (hours.isZero() && amount.isZero()))) {
    return fail("validation", "Budget consumption must be a positive hours or dollar value.");
  }
  if (eventType === "adjust" && hours.isZero() && amount.isZero()) {
    return fail("validation", "A budget adjustment must change hours or dollars.");
  }
  if (authType === "hours" && hours.isZero()) {
    return fail("validation", "This program requires an hours value.");
  }
  if (authType === "dollars" && amount.isZero()) {
    return fail("validation", "This program requires a dollar value.");
  }
  if (authType === "both" && (hours.isZero() || amount.isZero())) {
    return fail("validation", "This program requires both hours and dollars.");
  }
  const note = input.note?.trim() || null;
  if (eventType === "adjust" && (note?.length ?? 0) < 5) {
    return fail("validation", "Give a short reason for the budget adjustment.");
  }
  return ok({
    hours: toHours(hours),
    amount: toMoney(amount),
    sourceType,
    sourceId,
    note,
  });
}

function eventMatches(
  event: ProgramBudgetEventRecord,
  input: CreateProgramBudgetEventInput,
  values: { hours: string; amount: string; sourceType: string; sourceId: string; note: string | null },
): boolean {
  return event.budgetPeriodId === input.budgetPeriodId
    && event.programId === input.programId
    && event.eventType === (input.eventType ?? "consume")
    && event.serviceDate === input.serviceDate
    && dec(event.hours).eq(values.hours)
    && dec(event.amount).eq(values.amount)
    && event.sourceType === values.sourceType
    && event.sourceId === values.sourceId;
}

export async function createProgramBudgetEvent(
  pool: PgLikePool,
  input: CreateProgramBudgetEventInput,
  actorId: string,
): Promise<Result<ProgramBudgetEventRecord>> {
  if (!UUID.test(input.budgetPeriodId) || !UUID.test(input.programId)) {
    return fail("validation", "Choose a budget period and a program.");
  }
  if (!ISO_DATE.test(input.serviceDate)) return fail("validation", "Give a service date (YYYY-MM-DD).");
  const eventType = input.eventType ?? "consume";
  if (eventType !== "consume" && eventType !== "adjust") {
    return fail("validation", "Create a consumption or adjustment event.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountResult = await client.query<EventAccountRow>(
      `SELECT bp.individual_id, bp.start_date::text AS start_date,
              bp.end_date::text AS end_date, bp.status AS period_status,
              p.code AS program_code, p.required_auth_type, p.consumption_source
         FROM budget_periods bp
         JOIN budget_authorizations ba
           ON ba.budget_period_id = bp.id AND ba.program_id = $2 AND ba.status = 'active'
         JOIN programs p ON p.id = ba.program_id
        WHERE bp.id = $1
        FOR UPDATE OF bp, ba`,
      [input.budgetPeriodId, input.programId],
    );
    const account = accountResult.rows[0];
    if (!account) {
      await client.query("ROLLBACK");
      return fail("not_found", "That active program budget no longer exists.");
    }
    if (account.period_status !== "active") {
      await client.query("ROLLBACK");
      return fail("conflict", "That budget period is closed.");
    }
    if (account.program_code === "CLASSES") {
      await client.query("ROLLBACK");
      return fail("conflict", "Class invoice events must be recorded from the Classes workspace.");
    }
    if (input.serviceDate < account.start_date || input.serviceDate > account.end_date) {
      await client.query("ROLLBACK");
      return fail("validation", "The service date must be inside the budget period.");
    }
    if (eventType === "consume" && account.consumption_source === "payroll") {
      await client.query("ROLLBACK");
      return fail("conflict", "This program consumes its budget from payroll. Use an adjustment to correct its balance.");
    }
    const normalized = normalizedEventValues(input, account.required_auth_type);
    if (!normalized.ok) {
      await client.query("ROLLBACK");
      return normalized;
    }

    const tx = clientPool(client);
    const budget = await getProgramBudget(tx, input.budgetPeriodId, input.programId);
    if (!budget) throw new Error("Program budget balance could not be read.");
    const projectedHours = dec(budget.consumedHours).plus(normalized.data.hours);
    const projectedDollars = dec(budget.consumedDollars).plus(normalized.data.amount);
    const exceedsHours = account.required_auth_type !== "dollars"
      && projectedHours.gt(budget.authorizedHours);
    const exceedsDollars = account.required_auth_type !== "hours"
      && budget.authorizedDollars !== null
      && projectedDollars.gt(budget.authorizedDollars);
    const overrideReason = input.overBudgetOverrideReason?.trim() || null;
    if ((exceedsHours || exceedsDollars) && (overrideReason?.length ?? 0) < 5) {
      await client.query("ROLLBACK");
      return fail("conflict", "This event exceeds the authorized program budget. Add an override reason to continue.");
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO program_budget_events
         (budget_period_id, individual_id, program_id, event_type, service_date,
          hours, amount, source_type, source_id, note, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (source_type, source_id, event_type) DO NOTHING
       RETURNING id`,
      [
        input.budgetPeriodId,
        account.individual_id,
        input.programId,
        eventType,
        input.serviceDate,
        normalized.data.hours,
        normalized.data.amount,
        normalized.data.sourceType,
        normalized.data.sourceId,
        normalized.data.note,
        actorId,
      ],
    );

    let event: ProgramBudgetEventRecord | null;
    if (rows[0]) {
      event = await getProgramBudgetEvent(tx, rows[0].id);
    } else {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM program_budget_events
          WHERE source_type = $1 AND source_id = $2 AND event_type = $3`,
        [normalized.data.sourceType, normalized.data.sourceId, eventType],
      );
      event = existing.rows[0] ? await getProgramBudgetEvent(tx, existing.rows[0].id) : null;
      if (!event || !eventMatches(event, input, normalized.data)) {
        await client.query("ROLLBACK");
        return fail("conflict", "That source ID is already attached to a different budget event.");
      }
    }
    if (!event) throw new Error("Program budget event could not be read back.");

    if (rows[0]) {
      await recordChange(client, {
        actorId,
        action: "program_budget_event_created",
        entityType: "program_budget_event",
        entityId: event.id,
        next: event,
        reason: overrideReason ?? normalized.data.note,
      });
    }
    await client.query("COMMIT");
    return ok(event);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reverseProgramBudgetEvent(
  pool: PgLikePool,
  eventId: string,
  actorId: string,
  reason: string,
): Promise<Result<ProgramBudgetEventRecord>> {
  if (!UUID.test(eventId)) return fail("not_found", "That budget event no longer exists.");
  const reversalReason = reason?.trim() || "";
  if (reversalReason.length < 5) return fail("validation", "Give a reason for reversing this event.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const originalResult = await client.query<{
      id: string;
      budget_period_id: string;
      individual_id: string;
      program_id: string;
      event_type: string;
      service_date: string;
      hours: string;
      amount: string;
      source_type: string;
      source_id: string;
      program_code: string;
    }>(
      `SELECT e.id, e.budget_period_id, e.individual_id, e.program_id, e.event_type,
              e.service_date::text AS service_date, e.hours::text AS hours,
              e.amount::text AS amount, e.source_type, e.source_id, p.code AS program_code
         FROM program_budget_events e
         JOIN programs p ON p.id = e.program_id
        WHERE e.id = $1 FOR UPDATE OF e`,
      [eventId],
    );
    const original = originalResult.rows[0];
    if (!original) {
      await client.query("ROLLBACK");
      return fail("not_found", "That budget event no longer exists.");
    }
    if (original.event_type === "reverse") {
      await client.query("ROLLBACK");
      return fail("immutable", "A reversal cannot itself be reversed.");
    }
    if (original.program_code === "CLASSES") {
      await client.query("ROLLBACK");
      return fail("conflict", "Class invoice events must be reversed from the Classes workspace.");
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM program_budget_events WHERE reverses_event_id = $1`,
      [eventId],
    );
    if (existing.rows[0]) {
      const event = await getProgramBudgetEvent(clientPool(client), existing.rows[0].id);
      await client.query("COMMIT");
      return ok(event!);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO program_budget_events
         (budget_period_id, individual_id, program_id, event_type, service_date,
          hours, amount, source_type, source_id, reverses_event_id, note, created_by_user_id)
       VALUES ($1, $2, $3, 'reverse', $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (source_type, source_id, event_type) DO NOTHING
       RETURNING id`,
      [
        original.budget_period_id,
        original.individual_id,
        original.program_id,
        original.service_date,
        toHours(dec(original.hours).negated()),
        toMoney(dec(original.amount).negated()),
        original.source_type,
        original.source_id,
        original.id,
        reversalReason,
        actorId,
      ],
    );
    const reversalId = rows[0]?.id ?? (
      await client.query<{ id: string }>(
        `SELECT id FROM program_budget_events
          WHERE source_type = $1 AND source_id = $2 AND event_type = 'reverse'`,
        [original.source_type, original.source_id],
      )
    ).rows[0]?.id;
    if (!reversalId) throw new Error("Program budget reversal could not be created.");
    const reversal = await getProgramBudgetEvent(clientPool(client), reversalId);
    if (!reversal || reversal.reversesEventId !== original.id) {
      await client.query("ROLLBACK");
      return fail("conflict", "That source already has a different reversal.");
    }
    if (rows[0]) {
      await recordChange(client, {
        actorId,
        action: "program_budget_event_reversed",
        entityType: "program_budget_event",
        entityId: reversal.id,
        previous: { id: original.id, eventType: original.event_type },
        next: reversal,
        reason: reversalReason,
      });
    }
    await client.query("COMMIT");
    return ok(reversal);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

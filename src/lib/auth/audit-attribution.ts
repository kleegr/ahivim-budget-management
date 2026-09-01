import type { ImpersonationPayload, SessionPayload } from "./crypto";

export interface AuditAttribution {
  actorId: string | null;
  impersonatedUserId: string | null;
}

/**
 * Keep the effective portal identity separate from the person responsible for
 * a change. The signed owner-return proof is required on both sides, so a
 * caller cannot obtain owner attribution by merely supplying another user ID.
 */
export function auditAttributionFor(
  requestedActorId: string | null,
  session: SessionPayload | null,
  impersonation: ImpersonationPayload | null,
): AuditAttribution {
  if (
    !requestedActorId
    || !session
    || !impersonation
    || session.userId !== impersonation.targetUserId
    || session.impersonatorUserId !== impersonation.ownerUserId
    || (requestedActorId !== impersonation.targetUserId
      && requestedActorId !== impersonation.ownerUserId)
  ) {
    return { actorId: requestedActorId, impersonatedUserId: null };
  }

  return {
    actorId: impersonation.ownerUserId,
    impersonatedUserId: impersonation.targetUserId,
  };
}

/** Resolve request attribution when called from a route, with a safe fallback for jobs/tests. */
export async function resolveAuditAttribution(
  requestedActorId: string | null,
): Promise<AuditAttribution> {
  try {
    const { currentImpersonationSession, currentSession } = await import("./session");
    const [session, impersonation] = await Promise.all([
      currentSession(),
      currentImpersonationSession(),
    ]);
    return auditAttributionFor(requestedActorId, session, impersonation);
  } catch {
    return { actorId: requestedActorId, impersonatedUserId: null };
  }
}

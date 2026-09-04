export type ActivityNextStep =
  | "attention_person"
  | "attention_program"
  | "attention_date"
  | "attention_recipient"
  | "attention_group"
  | "attention_duplicate"
  | "attention_rate"
  | "ready";

export const ACTIVITY_NEXT_STEP_LABELS: Record<ActivityNextStep, string> = {
  attention_person: "Match person",
  attention_program: "Choose program",
  attention_date: "Add service date",
  attention_recipient: "Confirm recipient",
  attention_group: "Review group",
  attention_duplicate: "Check duplicate",
  attention_rate: "Review rate",
  ready: "Ready",
};

export interface ActivityStateInput {
  individualId: string | null;
  employeeId: string | null;
  programId: string | null;
  serviceDate?: string | null;
  paymentRecipient: string | null;
  matchStatus: string | null;
  groupDetectionStatus: string | null;
  hasOpenRateReview?: boolean;
}

/**
 * Give every recorded service one plain next step. The order is intentional:
 * identity and program gaps block trustworthy use first, followed by date and
 * payment routing, then review-only signals that do not remove the service
 * from canonical totals.
 */
export function activityNextStep(row: ActivityStateInput): ActivityNextStep {
  if (!row.individualId || !row.employeeId) return "attention_person";
  if (!row.programId) return "attention_program";
  if (!row.serviceDate) return "attention_date";
  if (!row.paymentRecipient || row.paymentRecipient === "unknown") return "attention_recipient";
  if (row.groupDetectionStatus === "needs_review") return "attention_group";
  if (row.matchStatus === "possible") return "attention_duplicate";
  if (row.hasOpenRateReview) return "attention_rate";
  return "ready";
}

export function activityNextStepLabel(row: ActivityStateInput): string {
  return ACTIVITY_NEXT_STEP_LABELS[activityNextStep(row)];
}

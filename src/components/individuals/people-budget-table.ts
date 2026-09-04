import { dec, formatHours } from "@/lib/money";

export type PeopleStatusFilter = "active" | "inactive" | "discharged" | "archived" | "all";
export type RenewalFilter = "all" | "next_30" | "next_60" | "next_90" | "overdue" | "missing";

type BudgetFacts = {
  status: string;
  missingRenewal: boolean;
  usedHours: number;
  hoursLeft: number | null;
  scheduledHours: number;
  hoursAfterScheduled: number | null;
  daysToRenewal: number | null;
  expired: boolean;
  mustUseWeekly: number | null;
};

export type PeopleBudgetTableRow = {
  id: string;
  status: string;
  archived: boolean;
  programs: string[];
  budget: BudgetFacts | null;
  hasCanonicalBudget: boolean;
  hasBilling: boolean;
  insightsVisible: boolean;
};

export type IndividualNextAction = {
  label: string;
  destination: "profile" | "budget";
  tone: "danger" | "warn" | "primary" | "muted";
};

export type PeopleBudgetTotals = {
  people: number;
  budgetPeople: number;
  authorizedHours: string;
  usedHours: string;
  scheduledHours: string;
  remainingAfterScheduledHours: string;
};

/** Authorized is already represented exactly by actual + remaining in the row read model. */
export function authorizedHours(budget: Pick<BudgetFacts, "usedHours" | "hoursLeft">): string | null {
  if (budget.hoursLeft === null) return null;
  return dec(budget.usedHours).plus(budget.hoursLeft).toString();
}

/** Sum only budget facts that survived the server-side access redaction. */
export function computePeopleBudgetTotals(rows: PeopleBudgetTableRow[]): PeopleBudgetTotals {
  let authorized = dec(0);
  let used = dec(0);
  let scheduled = dec(0);
  let remainingAfterScheduled = dec(0);
  let budgetPeople = 0;

  for (const row of rows) {
    if (!row.insightsVisible || !row.budget) continue;
    budgetPeople += 1;
    const rowAuthorized = authorizedHours(row.budget);
    if (rowAuthorized !== null) authorized = authorized.plus(rowAuthorized);
    used = used.plus(row.budget.usedHours);
    scheduled = scheduled.plus(row.budget.scheduledHours);
    if (row.budget.hoursAfterScheduled !== null) {
      remainingAfterScheduled = remainingAfterScheduled.plus(row.budget.hoursAfterScheduled);
    }
  }

  return {
    people: rows.length,
    budgetPeople,
    authorizedHours: authorized.toString(),
    usedHours: used.toString(),
    scheduledHours: scheduled.toString(),
    remainingAfterScheduledHours: remainingAfterScheduled.toString(),
  };
}

export function matchesPeopleStatus(row: PeopleBudgetTableRow, filter: PeopleStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "archived") return row.archived || row.status === "archived";
  return !row.archived && row.status === filter;
}

export function matchesProgram(row: PeopleBudgetTableRow, program: string): boolean {
  return program === "" || row.programs.includes(program);
}

export function matchesRenewal(row: PeopleBudgetTableRow, filter: RenewalFilter): boolean {
  if (filter === "all") return true;
  const budget = row.budget;
  if (!budget || !row.insightsVisible) return false;
  if (filter === "missing") return budget.missingRenewal;
  if (filter === "overdue") return budget.expired || (budget.daysToRenewal !== null && budget.daysToRenewal < 0);
  if (budget.daysToRenewal === null || budget.daysToRenewal < 0) return false;
  if (filter === "next_30") return budget.daysToRenewal <= 30;
  if (filter === "next_60") return budget.daysToRenewal <= 60;
  return budget.daysToRenewal <= 90;
}

/**
 * One concrete action per row, ordered from blocking setup/renewal issues to
 * schedule coverage. Hidden budget facts never influence the returned copy.
 */
export function individualNextAction(row: PeopleBudgetTableRow): IndividualNextAction {
  if (!row.insightsVisible) {
    return { label: "Open individual", destination: "profile", tone: "muted" };
  }
  if (row.archived || row.status !== "active") {
    return { label: "Review inactive record", destination: "profile", tone: "muted" };
  }
  if (!row.hasCanonicalBudget) {
    return row.hasBilling
      ? { label: "Create budget for billed work", destination: "budget", tone: "danger" }
      : { label: "Set up budget", destination: "budget", tone: "primary" };
  }
  if (!row.budget) {
    return { label: "Review dollar allowance", destination: "budget", tone: "primary" };
  }

  const budget = row.budget;
  if (budget.missingRenewal) {
    return { label: "Add renewal date", destination: "budget", tone: "danger" };
  }
  if (budget.expired) {
    return { label: "Renew authorization", destination: "budget", tone: "danger" };
  }
  if (budget.hoursAfterScheduled !== null && budget.hoursAfterScheduled < 0) {
    return {
      label: `Reduce schedule by ${formatHours(Math.abs(budget.hoursAfterScheduled))} h`,
      destination: "budget",
      tone: "danger",
    };
  }
  if (budget.hoursLeft !== null && budget.hoursLeft < 0) {
    return {
      label: `Review ${formatHours(Math.abs(budget.hoursLeft))} h overage`,
      destination: "budget",
      tone: "danger",
    };
  }
  if (budget.status === "fully_used" || budget.status === "near_exhaustion") {
    return { label: "Review remaining authorization", destination: "budget", tone: "warn" };
  }
  if (budget.daysToRenewal !== null && budget.daysToRenewal >= 0 && budget.daysToRenewal <= 60) {
    return { label: "Prepare renewal", destination: "budget", tone: "warn" };
  }
  if ((budget.mustUseWeekly ?? 0) > 0) {
    return {
      label: `Plan ${formatHours(budget.mustUseWeekly)} h/week`,
      destination: "budget",
      tone: budget.status === "behind_pace" ? "warn" : "primary",
    };
  }
  return { label: "Review budget", destination: "budget", tone: "muted" };
}

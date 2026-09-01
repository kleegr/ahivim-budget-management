/**
 * Build a link into the Transactions grid, pre-filtered. Every "see the rows
 * behind this number" affordance in the app routes through here, so a summary
 * figure and the ledger view it opens always describe the same set of rows.
 *
 * `pbFrom`/`pbTo` window on the service Period Begin (what budgets are measured
 * against); `from`/`to` window on the check date (the grid's period control).
 */
export interface TxLinkParams {
  transactionId?: string | null;
  transactionIds?: readonly string[] | null;
  individualId?: string | null;
  employeeId?: string | null;
  program?: string | null;
  programCode?: string | null;
  payTo?: string | null;
  checkNumber?: string | null;
  recipient?: string | null;
  group?: "1" | "0";
  /** Service-period (Period Begin) window. */
  pbFrom?: string | null;
  pbTo?: string | null;
  /** Check-date window. */
  from?: string | null;
  to?: string | null;
  /** Canonical service-date window used by operational and financial rollups. */
  serviceFrom?: string | null;
  serviceTo?: string | null;
}

export function txLink(p: TxLinkParams): string {
  const q = new URLSearchParams();
  if (p.transactionId) q.set("transactionId", p.transactionId);
  for (const id of p.transactionIds ?? []) q.append("transactionId", id);
  if (p.individualId) q.set("individualId", p.individualId);
  if (p.employeeId) q.set("employeeId", p.employeeId);
  if (p.program) q.set("program", p.program);
  if (p.programCode) q.set("programCode", p.programCode);
  if (p.payTo) q.set("payTo", p.payTo);
  if (p.checkNumber) q.set("checkNumber", p.checkNumber);
  if (p.recipient) q.set("recipient", p.recipient);
  if (p.group) q.set("group", p.group);
  if (p.pbFrom) q.set("pbFrom", p.pbFrom);
  if (p.pbTo) q.set("pbTo", p.pbTo);
  if (p.from && p.to) q.set("period", `${p.from}..${p.to}`);
  if (p.serviceFrom) q.set("serviceFrom", p.serviceFrom);
  if (p.serviceTo) q.set("serviceTo", p.serviceTo);
  const s = q.toString();
  return s ? `/transactions?${s}` : "/transactions";
}

"use client";

import { useEffect, useState } from "react";
import type { DocumentAccessContext } from "@/lib/auth/document-policy";

type Option = { id: string; name: string };
type AccessDetail = {
  context: DocumentAccessContext | null;
  individuals: Option[]; employees: Option[]; users: Option[]; agencies: Option[];
  versions: { id: string; number: number }[];
  publications: { user_id: string; title: string; name: string }[];
};
const outputCategories = [
  ["hours_budgets.self.read", "Individual hours"], ["dollar_budgets.self.read", "Individual budget dollars"],
  ["schedules.self.read", "Individual or employee schedule"],
  ["financials.self.billed_totals.read", "Individual billed totals"], ["financials.self.cuts_set_asides.read", "Individual put-away"],
  ["financials.self.direct_checks.read", "Individual safe direct-pay summary"], ["financials.self.agency_paid.read", "Individual agency-paid summary"],
  ["employee_pay.self.read", "Employee direct pay"], ["employee_checks.self.gross.read", "Employee gross"],
  ["employee_checks.self.net.read", "Employee net"], ["employee_checks.self.tax.read", "Employee taxes"],
  ["employee_giveback.self.read", "Employee give-back"], ["hours_budgets.agency.read", "Agency hours"],
  ["dollar_budgets.agency.read", "Agency budget dollars"], ["schedules.agency.read", "Agency schedule"],
  ["financials.agency.billed_totals.read", "Agency billed totals"], ["financials.agency.cuts_set_asides.read", "Agency set-aside"],
  ["financials.agency.direct_checks.read", "Agency direct checks"], ["financials.agency.agency_paid.read", "Agency paid"],
  ["settlements.agency.read", "Agency settlements"],
];

export default function DocumentAccessEditor({ documentId, onClose, onUpdated }: { documentId: string; onClose: () => void; onUpdated: () => void }) {
  const [detail, setDetail] = useState<AccessDetail | null>(null);
  const [kind, setKind] = useState("owner");
  const [individualId, setIndividual] = useState("");
  const [employeeId, setEmployee] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recipient, setRecipient] = useState("");
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [agency, setAgency] = useState("");
  const [scopeDate, setScopeDate] = useState("");
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/documents/${documentId}/access`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok || !body.ok) throw new Error(body.error); return body.data as AccessDetail; })
      .then((data) => { setDetail(data); setKind(data.context?.kind === "private" ? "owner" : data.context?.kind ?? "owner"); setIndividual(data.context?.individualId ?? ""); setEmployee(data.context?.employeeId ?? ""); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not load access."); });
    return () => controller.abort();
  }, [documentId]);

  async function save(body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/documents/${documentId}/access`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not save access.");
      setMessage("Document access saved."); setReviewed(false); onUpdated();
      if (body.action === "revoke") setDetail((current) => current && ({ ...current, publications: current.publications.filter((publication) => publication.user_id !== body.userId) }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save access."); }
    finally { setBusy(false); }
  }
  const select = (label: string, value: string, onChange: (value: string) => void, options: Option[]) => <label className="block text-sm">{label}<select className="input mt-1 w-full" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Choose…</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>;

  return <section aria-label="Document access" className="space-y-4 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Document access</h2><button type="button" className="btn btn-secondary" onClick={onClose}>Close</button></div>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
    {!detail ? <p>Loading document access…</p> : <>
      {!detail.context ? <p className="text-sm">This legacy document is preserved for the Owner until its audience is classified.</p> : null}
      <label className="block text-sm">Source audience<select className="input mt-1 w-full" value={kind} onChange={(event) => { setKind(event.target.value); setIndividual(""); setEmployee(""); setReviewed(false); }}><option value="owner">Owner only</option><option value="classes">Class billing</option><option value="planning">Hours planning, no money</option><option value="payroll">Employee payroll</option><option value="settlements">Collections and settlements</option></select></label>
      {kind === "classes" || kind === "planning" || kind === "settlements" ? select("Individual", individualId, setIndividual, detail.individuals) : null}
      {kind === "payroll" || kind === "settlements" ? select("Employee", employeeId, setEmployee, detail.employees) : null}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed the original, all older versions, editor contents, filenames and descriptions. They all belong to this audience and selected people.</label>
      <button type="button" className="btn btn-primary" disabled={busy || !reviewed} onClick={() => void save({ action: "classify", kind, individualId, employeeId, reviewedEntireSource: reviewed })}>Save source audience</button>
      <details onToggle={(event) => setPublishing(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-semibold">Approve a sanitized PDF for a portal recipient</summary>{publishing ? <div className="mt-4 space-y-3">
        <p className="text-sm">The recipient must already have a document grant and every selected category for the linked person or agency. Review the visible PDF for this recipient. Approval rebuilds a separate copy from page pixels and removes metadata, attachments, and hidden source objects.</p>
        <p className="text-sm">To grant portal documents, open <a className="underline" href="/settings/agencies" target="_blank" rel="noreferrer">Portal connections</a>, edit the recipient’s person or agency connection, and set Approved documents to Show.</p>
        {select("Recipient", recipient, setRecipient, detail.users)}
        {select("Secure saved output", version, setVersion, detail.versions.map((item) => ({ id: item.id, name: `Version ${item.number}` })))}
        {version ? <a href={`/api/documents/${documentId}/versions/${version}/file`} target="_blank" rel="noreferrer" className="text-sm underline">Review this PDF</a> : <p className="text-sm">Save a secure output in the editor before approving it.</p>}
        <label className="block text-sm">Safe title for recipient<input className="input mt-1 w-full" maxLength={180} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {select("Linked individual (choose one person)", individualId, (value) => { setIndividual(value); setEmployee(""); }, detail.individuals)}
        {select("Linked employee (choose one person)", employeeId, (value) => { setEmployee(value); setIndividual(""); }, detail.employees)}
        {select("Agency, when sharing through an agency", agency, setAgency, detail.agencies)}
        {agency ? <label className="block text-sm">Source date<input type="date" className="input mt-1 w-full" value={scopeDate} onChange={(event) => setScopeDate(event.target.value)} /></label> : null}
        <fieldset><legend className="text-sm font-semibold">Every category present in this output</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{outputCategories.map(([capability, label]) => <label key={capability} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={categories.includes(capability)} onChange={(event) => setCategories((current) => event.target.checked ? [...current, capability] : current.filter((item) => item !== capability))} />{label}</label>)}</div></fieldset>
        <button type="button" className="btn btn-primary" disabled={busy || !recipient || !version || !title || !categories.length} onClick={() => void save({ action: "publish", userId: recipient, versionId: version, title, individualId, employeeId, agencyId: agency, scopeDate: agency ? scopeDate : null, requiredCapabilities: categories, reviewedSanitizedOutput: true })}>Approve reviewed output for recipient</button>
      </div> : null}</details>
      {detail.publications.length ? <ul className="space-y-2">{detail.publications.map((publication) => <li className="flex items-center justify-between gap-3 text-sm" key={publication.user_id}><span>{publication.name}: {publication.title}</span><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save({ action: "revoke", userId: publication.user_id })}>Revoke</button></li>)}</ul> : null}
    </>}
  </section>;
}

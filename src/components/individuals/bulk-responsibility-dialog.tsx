"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RESPONSIBILITIES, RESPONSIBILITY_LABELS, type Responsibility } from "@/lib/business/operational-responsibility";
import type { ResponsibilityTarget, ResponsibilityChanges } from "@/lib/manage/bulk-responsibility";
import { ModalShell } from "@/components/schedule/shared";
import SearchableSelect from "@/components/manage/searchable-select";
export default function BulkResponsibilityDialog({ ids, selectionLabel }: { ids: string[]; selectionLabel: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<ResponsibilityTarget[]>([]);
  const [programs, setPrograms] = useState<Array<{ id: string; name: string }>>([]);
  const [general, setGeneral] = useState(false);
  const [selectedPrograms, setSelectedPrograms] = useState<string[]>([]);
  const [value, setValue] = useState<Responsibility>("undecided");
  const [reason, setReason] = useState("");
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [frozenIds, setFrozenIds] = useState<string[]>([]);
  const changes: ResponsibilityChanges = { ...(general ? { general: value } : {}), ...(selectedPrograms.length ? { programs: Object.fromEntries(selectedPrograms.map((id) => [id, value])) } : {}) };
  const preview = async (nextIds: string[]) => {
    setBusy(true); setMessage(null); setConfirmed(false); setTargets([]); setBatchIds([]); setSubmitted(false);
    try {
      const frozen: ResponsibilityTarget[] = [];
      const identities: string[] = [];
      for (let offset = 0; offset < nextIds.length; offset += 100) {
        const response = await fetch("/api/individuals/bulk-responsibility", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview", ids: nextIds.slice(offset, offset + 100) }) });
        const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error ?? "Could not preview selection.");
        frozen.push(...result.data.targets); identities.push(crypto.randomUUID()); setPrograms(result.data.programs);
      }
      setTargets(frozen); setBatchIds(identities);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not preview selection."); } finally { setBusy(false); }
  };
  return <><button type="button" className="btn btn-sm btn-primary" disabled={ids.length === 0} onClick={() => { const chosen = [...ids]; setFrozenIds(chosen); setOpen(true); void preview(chosen); }}>Bulk update responsibilities</button>
    {open ? <ModalShell title="Bulk update responsibilities" onClose={() => { if (!busy) setOpen(false); }}>
      <p className="text-sm">{selectionLabel}: <strong>{frozenIds.length} frozen people</strong>. Only the fields chosen below change. {frozenIds.length > 100 ? `${Math.ceil(frozenIds.length / 100)} atomic batches of up to 100 people will be saved in order. A failed batch leaves that whole batch unchanged; completed batches are reported separately.` : "This selection is saved atomically."}</p>
      <fieldset disabled={busy || submitted} className="my-4 space-y-3" onChange={() => setConfirmed(false)}>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={general} onChange={(event) => setGeneral(event.target.checked)} />Change general budget responsibility</label>
        <div><p className="mb-1 text-sm font-medium">Also change these specific program overrides</p><SearchableSelect label="programs" multiple values={selectedPrograms} onValuesChange={(next) => { setSelectedPrograms(next); setConfirmed(false); }} options={programs.map((program) => ({ value: program.id, label: program.name }))} /></div>
        <label className="block text-sm font-medium">New responsibility<select className="select mt-1 w-full" value={value} onChange={(event) => setValue(event.target.value as Responsibility)}>{RESPONSIBILITIES.map((state) => <option key={state} value={state}>{RESPONSIBILITY_LABELS[state]}</option>)}</select></label>
        <label className="block text-sm font-medium">Reason<input className="input mt-1 w-full" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      </fieldset>
      <p className="text-xs text-[var(--color-ink-soft)]">Unselected program overrides stay unchanged. Dated agency responsibility is available through each profile’s agency setup; this operational choice does not change roster access, billing, routing, or balances.</p>
      <div className="my-4 max-h-52 overflow-auto rounded border border-[var(--color-rule)] p-3"><p className="mb-2 text-sm font-semibold">Preview · {RESPONSIBILITY_LABELS[value]}</p>{targets.map((target) => <p key={target.id} className="border-b border-[var(--color-rule)] py-2 text-sm">{target.name}<span className="block text-xs text-[var(--color-ink-soft)]">{general ? `General: ${RESPONSIBILITY_LABELS[target.general ?? "undecided"]} → ${RESPONSIBILITY_LABELS[value]}. ` : "General unchanged. "}{selectedPrograms.length ? `${selectedPrograms.length} explicit program choices will change: ${programs.filter((program) => selectedPrograms.includes(program.id)).map((program) => program.name).join(", ")}.` : "All program overrides unchanged."}</span></p>)}</div>
      <label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed these people and the chosen fields.</label>
      {message ? <p role="alert" className="my-3 text-sm">{message}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="btn btn-primary" disabled={busy || !confirmed || !reason.trim() || (!general && !selectedPrograms.length) || targets.length !== frozenIds.length} onClick={async () => {
        setBusy(true); setMessage(null); setSubmitted(true);
        let saved = 0;
        try {
          for (let offset = 0; offset < targets.length; offset += 100) {
            const response = await fetch("/api/individuals/bulk-responsibility", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: batchIds[offset / 100], targets: targets.slice(offset, offset + 100).map(({ id, version }) => ({ id, version })), changes, reason }) });
            const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error ?? "Could not save. Retry this batch.");
            saved += result.data.count;
          }
          setMessage(`Saved ${saved} people. Selection and filters are retained.`); setConfirmed(false); router.refresh();
        } catch (error) { setMessage(`${saved} people saved in completed batches; other batches are unchanged. ${error instanceof Error ? error.message : "Could not save."} Retry uses the same frozen selection and will not duplicate completed batches.`); } finally { setBusy(false); }
      }}>{busy ? "Working…" : "Save this batch once"}</button><button type="button" disabled={busy} className="btn btn-secondary" onClick={() => void preview(frozenIds)}>Refresh stale preview</button></div>
    </ModalShell> : null}</>;
}

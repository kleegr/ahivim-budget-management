'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearSaveFeedback } from './save-feedback';
import { RESPONSIBILITIES, RESPONSIBILITY_LABELS, responsibilityForProgram, type Responsibility, type IndividualResponsibility, type EmployeeResponsibility } from '@/lib/business/operational-responsibility';

function Choice({ endpoint, label, field, value, programId, storedValue }: {
  endpoint: string; label: string; field: string; value: Responsibility; programId?: string; storedValue: Responsibility | null;
}) {
  const router = useRouter();
  const draftKey = `ahivim-responsibility-draft:${endpoint}:${field}:${programId ?? 'general'}`;
  const [choice, setChoice] = useState<Responsibility | null>(null);
  const [baseline, setBaseline] = useState(storedValue);
  const [savedChoice, setSavedChoice] = useState<Responsibility | null>(null);
  const selected = choice ?? savedChoice ?? value;
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);
      if (saved) {
        const draft = JSON.parse(saved);
        if (RESPONSIBILITIES.includes(draft.choice)) {
          setChoice(draft.choice); setBaseline(draft.baseline);
          setFeedback('Unsaved choice restored. Review it and save when ready.');
        }
      }
    } catch { /* The scoped form still works when storage is unavailable. */ }
  }, [draftKey]);
  useEffect(() => {
    if (choice === null) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [choice]);
  return <form className="flex flex-wrap items-end gap-3" onSubmit={async (event) => {
    event.preventDefault(); clearSaveFeedback(); setBusy(true); setFeedback(null); setFailed(false);
    try {
      const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field, value: selected, programId, expectedValue: baseline }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'Could not save. Try again.');
      setSavedChoice(selected); setBaseline(selected); setChoice(null); setBusy(false);
      try { sessionStorage.removeItem(draftKey); } catch { /* Saved successfully. */ }
      setFeedback('Saved this responsibility. Other unsaved choices are retained.');
      router.refresh();
    } catch (error) { setBusy(false); setFailed(true); setFeedback(error instanceof Error ? error.message : 'Could not save. Try again.'); }
  }}>
    <label className="min-w-0 flex-1 sm:min-w-56"><span className="mb-1 block text-sm font-medium">{label}</span>
      <select className="select w-full" value={selected} disabled={busy} onChange={(event) => { const next = event.target.value as Responsibility; setChoice(next); setFeedback(null); try { sessionStorage.setItem(draftKey, JSON.stringify({ choice: next, baseline })); } catch { /* Local state retains the draft. */ } }}>
        {RESPONSIBILITIES.map((value) => <option key={value} value={value}>{RESPONSIBILITY_LABELS[value]}</option>)}
      </select>
    </label>
    <button type="submit" disabled={busy} className="btn btn-secondary" aria-label={`Save ${label}`}>{busy ? 'Saving…' : 'Save'}</button>
    {choice !== null ? <span className="text-xs text-[var(--color-ink-soft)]">Unsaved choice</span> : null}
    {feedback ? <p role={failed ? 'alert' : 'status'} className={`w-full text-sm ${failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-soft)]'}`}>{feedback}</p> : null}
    {failed ? <button type="button" className="text-sm text-[var(--color-primary)] underline" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const response = await fetch(endpoint, { cache: 'no-store' }); const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error ?? 'Could not reload the current choice.');
        const current = result.data;
        const raw = field === 'budget' ? programId ? current.programs[programId] ?? null : current.source === 'saved' ? current.budget : null : current[field];
        const resolved = field === 'budget' ? programId ? current.programs[programId] ?? current.budget : current.budget : current[field];
        setBaseline(raw); setSavedChoice(resolved); setChoice(null); setFailed(false); setFeedback('Current choice loaded. You can make a new change; sibling drafts are retained.');
        try { sessionStorage.removeItem(draftKey); } catch { /* The in-memory state is current. */ }
      } catch (error) { setFeedback(error instanceof Error ? error.message : 'Could not reload the current choice.'); } finally { setBusy(false); }
    }}>Load current choice and discard this draft</button> : null}
  </form>;
}

export function IndividualResponsibilityEditor({ id, value, programs }: { id: string; value: IndividualResponsibility; programs: Array<{ id: string; name: string }> }) {
  const endpoint = `/api/individuals/${id}/responsibility`;
  return <section id="responsibility" aria-label="Budget responsibility" className="card mb-5 space-y-4 p-4 sm:p-5">
    <div><h2 className="text-base font-semibold">Budget responsibility</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Choose which budget setup we handle. Service activity and existing financial arrangements remain available.</p></div>
    <Choice endpoint={endpoint} label="General budget responsibility" field="budget" value={value.budget} storedValue={value.source === 'saved' ? value.budget : null} />
    {value.source === 'agency' ? <p className="text-xs text-[var(--color-ink-faint)]">Current choice comes from the saved home-agency responsibility.</p> : null}
    <details className="border-t border-[var(--color-rule)] pt-3"><summary className="cursor-pointer text-sm font-semibold">Program responsibility</summary>
      <p className="my-3 text-sm text-[var(--color-ink-soft)]">Programs use the general choice until you save a separate choice here.</p>
      <div className="grid gap-4 lg:grid-cols-2">{programs.map((program) => <div key={program.id} className="min-w-0 rounded border border-[var(--color-rule)] p-3"><Choice endpoint={endpoint} label={`${program.name} budget responsibility`} field="budget" value={responsibilityForProgram(value, program.id)} storedValue={value.programs[program.id] ?? null} programId={program.id} /><p className="mt-2 text-xs text-[var(--color-ink-faint)]">{value.programs[program.id] ? 'Separate program choice' : 'Uses general choice'}</p></div>)}</div>
    </details>
  </section>;
}

export function EmployeeResponsibilityEditor({ id, value }: { id: string; value: EmployeeResponsibility }) {
  const endpoint = `/api/employees/${id}/responsibility`;
  return <section id="responsibility" aria-label="Employee responsibilities" className="card mb-5 space-y-4 p-4 sm:p-5">
    <div><h2 className="text-base font-semibold">What we handle</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Scheduling and money operations are separate responsibilities. Existing arrangements, payment routing, and balances keep their saved terms.</p></div>
    <div className="grid gap-5 lg:grid-cols-2"><Choice endpoint={endpoint} label="Scheduling responsibility" field="scheduling" value={value.scheduling} storedValue={value.scheduling} /><Choice endpoint={endpoint} label="Money operations responsibility" field="money" value={value.money} storedValue={value.money} /></div>
  </section>;
}

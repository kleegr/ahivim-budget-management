'use client';
import { useState } from 'react';
import { clearSaveFeedback, refreshWithSaveFeedback } from './save-feedback';
import { RESPONSIBILITIES, RESPONSIBILITY_LABELS, responsibilityForProgram, type Responsibility, type IndividualResponsibility, type EmployeeResponsibility } from '@/lib/business/operational-responsibility';

function Choice({ endpoint, label, field, value, programId }: {
  endpoint: string; label: string; field: string; value: Responsibility; programId?: string;
}) {
  const [choice, setChoice] = useState<Responsibility | null>(null);
  const selected = choice ?? value;
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return <form className="flex flex-wrap items-end gap-3" onSubmit={async (event) => {
    event.preventDefault(); clearSaveFeedback(); setBusy(true); setFeedback(null); setFailed(false);
    try {
      const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field, value: selected, programId }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'Could not save. Try again.');
      refreshWithSaveFeedback('Saved. Review state updated.');
    } catch (error) { setBusy(false); setFailed(true); setFeedback(error instanceof Error ? error.message : 'Could not save. Try again.'); }
  }}>
    <label className="min-w-0 flex-1 sm:min-w-56"><span className="mb-1 block text-sm font-medium">{label}</span>
      <select className="select w-full" value={selected} disabled={busy} onChange={(event) => { setChoice(event.target.value as Responsibility); setFeedback(null); }}>
        {RESPONSIBILITIES.map((value) => <option key={value} value={value}>{RESPONSIBILITY_LABELS[value]}</option>)}
      </select>
    </label>
    <button type="submit" disabled={busy} className="btn btn-secondary" aria-label={`Save ${label}`}>{busy ? 'Saving…' : 'Save'}</button>
    {feedback ? <p role={failed ? 'alert' : 'status'} className={`w-full text-sm ${failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-soft)]'}`}>{feedback}</p> : null}
  </form>;
}

export function IndividualResponsibilityEditor({ id, value, programs }: { id: string; value: IndividualResponsibility; programs: Array<{ id: string; name: string }> }) {
  const endpoint = `/api/individuals/${id}/responsibility`;
  return <section id="responsibility" aria-label="Budget responsibility" className="card mb-5 space-y-4 p-4 sm:p-5">
    <div><h2 className="text-base font-semibold">Budget responsibility</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Choose which budget setup we handle. Service activity and existing financial arrangements remain available.</p></div>
    <Choice endpoint={endpoint} label="General budget responsibility" field="budget" value={value.budget} />
    {value.source === 'agency' ? <p className="text-xs text-[var(--color-ink-faint)]">Current choice comes from the saved home-agency responsibility.</p> : null}
    <details className="border-t border-[var(--color-rule)] pt-3"><summary className="cursor-pointer text-sm font-semibold">Program responsibility</summary>
      <p className="my-3 text-sm text-[var(--color-ink-soft)]">Programs use the general choice until you save a separate choice here.</p>
      <div className="grid gap-4 lg:grid-cols-2">{programs.map((program) => <div key={program.id} className="min-w-0 rounded border border-[var(--color-rule)] p-3"><Choice endpoint={endpoint} label={`${program.name} budget responsibility`} field="budget" value={responsibilityForProgram(value, program.id)} programId={program.id} /><p className="mt-2 text-xs text-[var(--color-ink-faint)]">{value.programs[program.id] ? 'Separate program choice' : 'Uses general choice'}</p></div>)}</div>
    </details>
  </section>;
}

export function EmployeeResponsibilityEditor({ id, value }: { id: string; value: EmployeeResponsibility }) {
  const endpoint = `/api/employees/${id}/responsibility`;
  return <section id="responsibility" aria-label="Employee responsibilities" className="card mb-5 space-y-4 p-4 sm:p-5">
    <div><h2 className="text-base font-semibold">What we handle</h2><p className="mt-1 text-sm text-[var(--color-ink-soft)]">Scheduling and money operations are separate responsibilities. Existing arrangements, payment routing, and balances keep their saved terms.</p></div>
    <div className="grid gap-5 lg:grid-cols-2"><Choice endpoint={endpoint} label="Scheduling responsibility" field="scheduling" value={value.scheduling} /><Choice endpoint={endpoint} label="Money operations responsibility" field="money" value={value.money} /></div>
  </section>;
}

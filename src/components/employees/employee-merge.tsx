"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/manage/client";

interface Candidate {
  id: string;
  name: string;
  txCount: number;
  similarity: number;
}

/**
 * Merge a duplicate employee into this one. Lists other employee records (a
 * spelling variant mints a separate row on import), ranked by name similarity;
 * picking one repoints all of its transactions onto this employee and archives
 * the duplicate. Manager only; mounted on the employee profile.
 */
export default function EmployeeMerge({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cands, setCands] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/employees/${employeeId}/merge${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
        .then((r) => r.json())
        .then((j) => { if (alive && j.ok) setCands(j.data); })
        .catch(() => {})
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [open, q, employeeId]);

  const merge = async (c: Candidate) => {
    if (!window.confirm(`Merge “${c.name}” (${c.txCount.toLocaleString()} transactions) into “${employeeName}”? “${c.name}” will be archived and all its transactions moved here. This is recorded and reversible via support.`)) return;
    setBusy(c.id); setErr(null);
    try {
      const res = await fetch(`/api/employees/${employeeId}/merge`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mergeId: c.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Merge failed.");
      setOpen(false);
      router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Merge failed."); setBusy(null); }
  };

  const strong = useMemo(() => cands.filter((c) => c.similarity >= 0.8), [cands]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--color-ink)]">
        Merge duplicate
      </button>
      {open ? (
        <Modal title={`Merge a duplicate into ${employeeName}`} onClose={() => setOpen(false)}>
          <div className="space-y-3">
            {err ? <p className="rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-danger)]">{err}</p> : null}
            <p className="text-sm text-[var(--color-ink-soft)]">Pick the duplicate record. Its transactions move onto <span className="font-medium">{employeeName}</span> and the duplicate is archived. {strong.length ? "Likely matches are listed first." : ""}</p>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employees…" className="input w-full" autoFocus />
            <div className="scroll-thin max-h-72 overflow-auto rounded-lg border border-[var(--color-rule)]">
              {loading ? (
                <p className="px-3 py-6 text-center text-sm text-[var(--color-text-soft)]">Loading…</p>
              ) : cands.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-[var(--color-text-soft)]">No other employees found.</p>
              ) : cands.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 border-b border-[var(--color-rule)] px-3 py-2 last:border-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{c.name}
                      {c.similarity >= 0.8 ? <span className="ml-1.5 rounded bg-[var(--color-warn-soft)] px-1 text-[10px] text-[var(--color-warn)]">likely match</span> : null}
                    </div>
                    <div className="text-xs text-[var(--color-text-soft)]">{c.txCount.toLocaleString()} transaction{c.txCount === 1 ? "" : "s"}</div>
                  </div>
                  <button type="button" disabled={!!busy} onClick={() => merge(c)} className="btn btn-sm btn-secondary shrink-0">{busy === c.id ? "Merging…" : "Merge in"}</button>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

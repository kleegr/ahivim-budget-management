"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui";
import { ActionButton } from "@/components/manage/client";

/**
 * The Employees register as a fast client grid — live search and sort, a
 * show-archived toggle, no Apply-filters page reload. This mirrors the
 * Individuals list so "how do I filter?" has one answer everywhere.
 */

export type EmployeeRow = {
  id: string;
  name: string;
  externalRef: string | null;
  status: string;
  archived: boolean;
};

type SortKey = "name" | "ref" | "status";

export default function EmployeesList({ rows, canEdit }: { rows: EmployeeRow[]; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows.filter((r) => (showArchived ? true : !r.archived));
    if (needle) {
      list = list.filter((r) => r.name.toLowerCase().includes(needle) || (r.externalRef ?? "").toLowerCase().includes(needle));
    }
    const cmp = (a: EmployeeRow, b: EmployeeRow) => {
      let d = 0;
      if (sort.key === "name") d = a.name.localeCompare(b.name);
      else if (sort.key === "ref") d = (a.externalRef ?? "").localeCompare(b.externalRef ?? "");
      else d = a.status.localeCompare(b.status);
      if (d === 0) d = a.name.localeCompare(b.name);
      return sort.dir === "asc" ? d : -d;
    };
    return list.slice().sort(cmp);
  }, [rows, q, showArchived, sort]);

  const archivedCount = useMemo(() => rows.filter((r) => r.archived).length, [rows]);
  const toggle = (key: SortKey) => setSort((p) => (p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const Head = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th className="whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold">
      <button type="button" onClick={() => toggle(k)} className="inline-flex items-center gap-1 hover:underline" title="Sort">
        {children}
        <span className="text-[10px] text-[var(--color-primary)]">{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or reference…" className="input w-64 max-w-full" aria-label="Search employees" />
        {archivedCount > 0 ? (
          <label className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived ({archivedCount})
          </label>
        ) : null}
        <span className="ml-auto text-sm text-[var(--color-text-soft)]">
          <span className="tnum font-semibold text-[var(--color-ink)]">{visible.length}</span> {visible.length === 1 ? "employee" : "employees"}
        </span>
      </div>

      <div className="scroll-thin max-h-[68vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <Head k="name">Name</Head>
              <Head k="ref">Reference</Head>
              <Head k="status">Status</Head>
              {canEdit ? <th className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)]">
                <td className="px-3 py-2">
                  <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/employees/${r.id}`}>
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-[var(--color-ink-soft)]">{r.externalRef ?? <span className="text-[var(--color-ink-faint)]">—</span>}</td>
                <td className="px-3 py-2"><Badge value={r.status} /></td>
                {canEdit ? (
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.archived ? (
                      <ActionButton label="Restore" endpoint={`/api/employees/${r.id}`} body={{ action: "restore" }} withReason />
                    ) : (
                      <ActionButton label="Archive" endpoint={`/api/employees/${r.id}`} body={{ action: "archive" }} withReason />
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={canEdit ? 4 : 3} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  {rows.length === 0 ? "No employees yet — they appear here once a workbook is committed." : "No one matches your search."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

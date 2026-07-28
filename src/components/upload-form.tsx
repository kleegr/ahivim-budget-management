"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Uploads one .xlsx and, on success, moves straight to its review screen. */
export default function UploadForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || !file.name) {
      setError("Choose a workbook first.");
      return;
    }
    setBusy(true);
    setError(null);
    setExistingId(null);
    try {
      const response = await fetch("/api/imports", { method: "POST", body: data });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        fileId?: string | null;
      };
      if (!response.ok || !body.ok) {
        setError(body.error ?? "The upload failed.");
        setExistingId(body.fileId ?? null);
        setBusy(false);
        return;
      }
      form.reset();
      router.push(`/imports/${body.fileId}`);
      router.refresh();
    } catch {
      setError("Could not reach the server. The file was not uploaded.");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-4"
    >
      <h2 className="display text-base font-medium">Upload a workbook</h2>
      <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
        .xlsx only. The file is checksummed with SHA-256; a workbook that has already been
        committed is refused rather than imported a second time.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]"
        >
          {error}
          {existingId ? (
            <>
              {" "}
              <a className="underline underline-offset-2" href={`/imports/${existingId}`}>
                Open the existing import
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium" htmlFor="file">
            Workbook file
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            disabled={busy}
            className="mt-1 block text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? "Parsing and staging…" : "Upload and stage"}
        </button>
      </div>
      {busy ? (
        <p role="status" className="mt-2 text-xs text-[var(--color-ink-faint)]">
          Reading every source row. A large workbook can take a minute.
        </p>
      ) : null}
    </form>
  );
}

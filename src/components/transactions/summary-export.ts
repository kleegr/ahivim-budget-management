"use client";

import type { ExportCell, ExportColumn } from "@/lib/export/tabular";

export async function downloadTransactionSummary({
  format,
  title,
  filename,
  columns,
  rows,
}: {
  format: "csv" | "xlsx";
  title: string;
  filename: string;
  columns: ExportColumn[];
  rows: Record<string, ExportCell>[];
}): Promise<void> {
  const response = await fetch("/api/transactions/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format, title, filename, columns, rows }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error ?? `Could not export ${title.toLocaleLowerCase()}.`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

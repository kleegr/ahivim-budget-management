"use client";

import { Printer } from "lucide-react";

export default function PrintStatementButton() {
  return (
    <button type="button" className="btn btn-secondary print:hidden" onClick={() => window.print()}>
      <Printer aria-hidden className="h-4 w-4" />
      Print statement
    </button>
  );
}

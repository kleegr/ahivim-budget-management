"use client";

import { useState } from "react";
import { Field, TextAreaField } from "@/components/manage/client";

export interface ProgramBudgetOption {
  id: string;
  code: string;
  name: string;
  requiredAuthType: "hours" | "dollars" | "both";
  defaultAgencyRate: string | null;
  defaultInternalRate: string | null;
  allowIndividualRateOverride: boolean;
}

function FixedRateField({ label, value }: { label: string; value: string | null }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        disabled
        className="mt-1 w-full rounded border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-1.5 text-sm text-[var(--color-ink-soft)]"
      />
    </label>
  );
}

/** Program-aware fields for the shared CreateButton form. */
export default function ProgramBudgetFields({
  programs,
  showInternalRate,
  showAgencyRate,
}: {
  programs: ProgramBudgetOption[];
  showInternalRate: boolean;
  showAgencyRate: boolean;
}) {
  const [programId, setProgramId] = useState(programs[0]?.id ?? "");
  const selected = programs.find((program) => program.id === programId) ?? programs[0];
  const needsHours = selected?.requiredAuthType === "hours" || selected?.requiredAuthType === "both";
  const needsDollars = selected?.requiredAuthType === "dollars" || selected?.requiredAuthType === "both";

  return (
    <>
      <label className="block">
        <span className="text-sm font-medium">Program</span>
        <select
          name="programId"
          required
          value={programId}
          onChange={(event) => setProgramId(event.target.value)}
          className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
        >
          {programs.map((program) => (
            <option key={program.id} value={program.id}>
              {program.code} - {program.name}
            </option>
          ))}
        </select>
      </label>

      <Field label="Period label" name="label" placeholder="Annual authorization" />
      <input type="hidden" name="periodType" value="custom" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts" name="startDate" type="date" required />
        <Field label="Ends" name="endDate" type="date" required />
      </div>
      <Field label="Renewal date" name="renewalDate" type="date" />

      <div className={`grid gap-3 ${needsHours && needsDollars ? "sm:grid-cols-2" : ""}`}>
        {needsHours ? (
          <Field label="Authorized hours" name="authorizedHours" type="number" required />
        ) : (
          <input type="hidden" name="authorizedHours" value="0" />
        )}
        {needsDollars ? (
          <Field label="Authorized amount" name="authorizedDollars" type="number" required />
        ) : null}
      </div>

      {needsHours && (showAgencyRate || showInternalRate) ? (
        <div className={`grid gap-3 ${showAgencyRate && showInternalRate ? "sm:grid-cols-2" : ""}`}>
          {showAgencyRate ? selected?.allowIndividualRateOverride ? (
            <Field
              key={`agency:${selected.id}`}
              label="Funder / agency rate"
              name="agencyRate"
              type="number"
              placeholder={selected.defaultAgencyRate ?? "No catalog rate"}
            />
          ) : (
            <FixedRateField label="Funder / agency rate" value={selected?.defaultAgencyRate ?? null} />
          ) : null}
          {showInternalRate ? selected?.allowIndividualRateOverride ? (
            <Field
              key={`internal:${selected.id}`}
              label="Employee / internal rate"
              name="individualRateOverride"
              type="number"
              placeholder={selected.defaultInternalRate ?? "Enter a rate"}
              required={selected.defaultInternalRate === null}
            />
          ) : (
            <FixedRateField label="Employee / internal rate" value={selected?.defaultInternalRate ?? null} />
          ) : null}
        </div>
      ) : null}
      <TextAreaField label="Notes" name="notes" />
      <TextAreaField label="Reason for authorization" name="reason" />
    </>
  );
}

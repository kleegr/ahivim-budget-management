"use client";

import { useEffect, useState } from "react";
import { Download, FilePenLine, Save } from "lucide-react";
import { ModalShell } from "@/components/schedule/shared";
import type { ClassInvoiceRecord } from "@/lib/data/class-invoices";
import type { ClassReimbursementProfile } from "@/lib/data/class-reimbursement-profiles";
import { classRequest } from "./invoice-builder";

type InvoiceSummary = Omit<ClassInvoiceRecord, "lines">;

const EMPTY_PROFILE: ClassReimbursementProfile = {
  id: null,
  individualId: "",
  individualName: "",
  mailingName: "",
  addressLine1: "",
  addressLine2: "",
  cityStateZip: "",
  phone: "",
  dateOfBirth: "",
  medicaidId: "",
  fiscalIntermediary: "Ahivim",
  payableTo: "Xcellent Staffing",
  lifePlanConfirmed: false,
  budgetCategory: "Community classes",
  formCompletedBy: "",
  relationship: "",
  updatedAt: null,
};

export default function ClassCoverSheetDialog({
  invoice,
  canManage,
  canEditDocuments,
  onClose,
}: {
  invoice: InvoiceSummary;
  canManage: boolean;
  canEditDocuments: boolean;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<ClassReimbursementProfile>({
    ...EMPTY_PROFILE,
    individualId: invoice.individualId,
    individualName: invoice.individualName,
    mailingName: invoice.billToName,
    addressLine1: invoice.billToAddressLine1,
    addressLine2: invoice.billToAddressLine2,
    cityStateZip: invoice.billToCityStateZip,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let current = true;
    void classRequest<ClassReimbursementProfile>(`/api/classes/profiles/${invoice.individualId}`)
      .then((result) => {
        if (!current) return;
        if (result.ok && result.data) {
          setProfile({
            ...result.data,
            mailingName: result.data.mailingName || invoice.billToName,
            addressLine1: result.data.addressLine1 || invoice.billToAddressLine1,
            addressLine2: result.data.addressLine2 || invoice.billToAddressLine2,
            cityStateZip: result.data.cityStateZip || invoice.billToCityStateZip,
          });
        } else {
          setError(result.error ?? "Could not load the reimbursement profile.");
        }
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [invoice]);

  const set = <K extends keyof ClassReimbursementProfile>(key: K, value: ClassReimbursementProfile[K]) => {
    setProfile((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    const result = await classRequest<ClassReimbursementProfile>(
      `/api/classes/profiles/${invoice.individualId}`,
      "PATCH",
      {
        mailingName: profile.mailingName,
        addressLine1: profile.addressLine1,
        addressLine2: profile.addressLine2,
        cityStateZip: profile.cityStateZip,
        phone: profile.phone,
        dateOfBirth: profile.dateOfBirth,
        medicaidId: profile.medicaidId,
        fiscalIntermediary: profile.fiscalIntermediary,
        payableTo: profile.payableTo,
        lifePlanConfirmed: profile.lifePlanConfirmed,
        budgetCategory: profile.budgetCategory,
        formCompletedBy: profile.formCompletedBy,
        relationship: profile.relationship,
      },
    );
    setSaving(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not save the reimbursement profile.");
      return false;
    }
    setProfile(result.data);
    setSaved(true);
    return true;
  };

  const saveAndOpenEditor = async () => {
    if (!canManage || !canEditDocuments) return;
    if (!(await save())) return;
    const finalized = await finalize();
    if (!finalized) return;
    window.location.assign(`/documents/pdf-editor?source=${encodeURIComponent(finalized)}`);
  };

  const finalize = async (): Promise<string | null> => {
    setSaving(true);
    setError(null);
    const result = await classRequest<{ href: string }>(
      `/api/classes/invoices/${invoice.id}/cover-sheet`,
      "POST",
    );
    setSaving(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not finalize the reimbursement cover sheet.");
      return null;
    }
    return result.data.href;
  };

  const saveAndDownload = async () => {
    let href = `/api/classes/invoices/${invoice.id}/cover-sheet`;
    if (canManage) {
      if (!(await save())) return;
      const finalized = await finalize();
      if (!finalized) return;
      href = finalized;
    }
    const link = document.createElement("a");
    link.href = href;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const disabled = loading || !canManage;

  return (
    <ModalShell title={`Reimbursement - ${invoice.individualName}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Name
            <input className="input mt-1 w-full" disabled={disabled} value={profile.mailingName ?? ""} onChange={(event) => set("mailingName", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Phone
            <input className="input mt-1 w-full" disabled={disabled} value={profile.phone ?? ""} onChange={(event) => set("phone", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Address line 1
            <input className="input mt-1 w-full" disabled={disabled} value={profile.addressLine1 ?? ""} onChange={(event) => set("addressLine1", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Address line 2
            <input className="input mt-1 w-full" disabled={disabled} value={profile.addressLine2 ?? ""} onChange={(event) => set("addressLine2", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)] sm:col-span-2">
            City, state and ZIP
            <input className="input mt-1 w-full" disabled={disabled} value={profile.cityStateZip ?? ""} onChange={(event) => set("cityStateZip", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Date of birth
            <input className="input mt-1 w-full" type="date" disabled={disabled} value={profile.dateOfBirth ?? ""} onChange={(event) => set("dateOfBirth", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Medicaid ID
            <input className="input mt-1 w-full" disabled={disabled} value={profile.medicaidId ?? ""} onChange={(event) => set("medicaidId", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Fiscal intermediary
            <input className="input mt-1 w-full" disabled={disabled} value={profile.fiscalIntermediary} onChange={(event) => set("fiscalIntermediary", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Payable to
            <input className="input mt-1 w-full" disabled={disabled} value={profile.payableTo} onChange={(event) => set("payableTo", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Budget category
            <input className="input mt-1 w-full" disabled={disabled} value={profile.budgetCategory} onChange={(event) => set("budgetCategory", event.target.value)} />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm font-medium">
            <input type="checkbox" disabled={disabled} checked={profile.lifePlanConfirmed} onChange={(event) => set("lifePlanConfirmed", event.target.checked)} />
            Listed in Life Plan
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Form completed by
            <input className="input mt-1 w-full" disabled={disabled} value={profile.formCompletedBy ?? ""} onChange={(event) => set("formCompletedBy", event.target.value)} />
          </label>
          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
            Relationship
            <input className="input mt-1 w-full" disabled={disabled} value={profile.relationship ?? ""} onChange={(event) => set("relationship", event.target.value)} />
          </label>
        </div>

        {error ? <p className="text-sm font-medium text-[var(--color-danger)]" role="alert">{error}</p> : null}
        {!loading && canManage && !profile.lifePlanConfirmed ? (
          <p className="text-sm text-[var(--color-warn)]">Life Plan confirmation is required the first time this cover sheet is finalized.</p>
        ) : null}
        {saved ? <p className="text-sm font-medium text-[var(--color-success)]" role="status">Saved</p> : null}

        <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--color-rule)] pt-4">
          {canEditDocuments && canManage ? (
            <button type="button" className="btn btn-secondary" disabled={loading || saving} onClick={() => void saveAndOpenEditor()}>
              <FilePenLine className="h-4 w-4" aria-hidden />
              {saving ? "Saving..." : "Save & edit PDF"}
            </button>
          ) : <span />}
          <div className="flex flex-wrap justify-end gap-2">
            {canManage ? (
              <button type="button" className="btn btn-secondary" disabled={loading || saving} onClick={() => void save()}>
                <Save className="h-4 w-4" aria-hidden />
                {saving ? "Saving..." : "Save profile"}
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" disabled={loading || saving} onClick={() => void saveAndDownload()}>
              <Download className="h-4 w-4" aria-hidden />
              {saving ? "Saving..." : "Cover sheet"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

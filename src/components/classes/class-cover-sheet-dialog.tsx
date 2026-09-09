"use client";

import { useEffect, useState } from "react";
import { Download, Eye, FilePenLine, Save } from "lucide-react";
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
  const [finalized, setFinalized] = useState(false);
  const [version, setVersion] = useState(1);
  const [versions, setVersions] = useState<{ version: number; reason: string | null; createdAt: string }[]>([]);
  const [editingFuture, setEditingFuture] = useState(false);
  const [correctionReason, setCorrectionReason] = useState("");
  const isVoid = invoice.status === "void";

  useEffect(() => {
    let current = true;
    void classRequest<{ profile: ClassReimbursementProfile | null; finalized: boolean; version: number; versions: { version: number; reason: string | null; createdAt: string }[] }>(`/api/classes/invoices/${invoice.id}/cover-sheet?metadata=1`)
      .then((result) => {
        if (!current) return;
        if (result.ok && result.data) {
          setFinalized(result.data.finalized);
          setVersion(result.data.version);
          setVersions(result.data.versions);
          if (!result.data.profile) {
            setError("No cover sheet was finalized for this void invoice. Its issued invoice remains available in history.");
            setLoading(false);
            return;
          }
          setProfile(result.data.finalized ? result.data.profile : {
            ...result.data.profile,
            mailingName: result.data.profile.mailingName || invoice.billToName,
            addressLine1: result.data.profile.addressLine1 || invoice.billToAddressLine1,
            addressLine2: result.data.profile.addressLine2 || invoice.billToAddressLine2,
            cityStateZip: result.data.profile.cityStateZip || invoice.billToCityStateZip,
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

  const save = async (): Promise<ClassReimbursementProfile | null> => {
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
      return null;
    }
    setProfile(result.data);
    setSaved(true);
    return result.data;
  };

  const saveAndOpenEditor = async () => {
    if (!canManage || !canEditDocuments) return;
    if (finalized) {
      window.location.assign(`/documents/pdf-editor?source=${encodeURIComponent(`/api/classes/invoices/${invoice.id}/cover-sheet?version=${version}`)}`);
      return;
    }
    if (!(await save())) return;
    const finalizedHref = await finalize();
    if (!finalizedHref) return;
    window.location.assign(`/documents/pdf-editor?source=${encodeURIComponent(finalizedHref)}`);
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
    setFinalized(true);
    return result.data.href;
  };

  const saveAndDownload = async () => {
    let href = `/api/classes/invoices/${invoice.id}/cover-sheet?version=${version}`;
    if (canManage && !finalized && !isVoid) {
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

  const saveAndPreview = async () => {
    const previewWindow = window.open("about:blank", "_blank");
    if (previewWindow) previewWindow.opener = null;
    if (!finalized && !isVoid && !(await save())) {
      previewWindow?.close();
      return;
    }
    const href = `/api/classes/invoices/${invoice.id}/cover-sheet?preview=1${finalized ? `&version=${version}` : ""}`;
    if (previewWindow) {
      previewWindow.location.href = href;
      return;
    }
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const disabled = loading || !canManage || isVoid || (finalized && !editingFuture);
  const draft = invoice.status === "draft";

  return (
    <ModalShell title={`Reimbursement - ${invoice.individualName}`} onClose={onClose} wide>
      <div className="space-y-4">
        {isVoid ? <p role="status" className="font-semibold text-[var(--color-danger)]">VOID — {invoice.voidReason}. Historical output retains issued facts.</p> : null}
        {finalized ? <div className="rounded-lg border border-[var(--color-rule)] p-3 space-y-2">
          <p className="text-sm font-semibold">Finalized cover — version {version}</p>
          <p className="text-xs">Preview, download and Save to Documents use this frozen version. Reusable profile changes apply to future covers.</p>
          <select className="select" aria-label="Cover version" value={version} onChange={async event => {
            const next = Number(event.target.value); setLoading(true); setError(null);
            const result = await classRequest<{ profile: ClassReimbursementProfile; finalized: boolean }>(`/api/classes/invoices/${invoice.id}/cover-sheet?metadata=1&version=${next}`);
            setLoading(false);
            if (!result.ok || !result.data?.finalized) { setError(result.error ?? "Could not load that version."); return; }
            setVersion(next); setProfile(result.data.profile); setEditingFuture(false);
          }}>{versions.length ? versions.map(item => <option key={item.version} value={item.version}>Version {item.version}{item.reason ? ` — ${item.reason}` : " — Original"}</option>) : <option value={version}>Version {version}</option>}</select>
          {canManage && !isVoid ? <button type="button" className="btn btn-sm btn-secondary" onClick={async () => {
            const result = await classRequest<ClassReimbursementProfile>(`/api/classes/profiles/${invoice.individualId}`);
            if (!result.ok || !result.data) { setError(result.error ?? "Could not load the reusable profile."); return; }
            setProfile(result.data); setEditingFuture(true);
          }}>Edit reusable profile for future covers</button> : null}
        </div> : null}
        {editingFuture ? <div className="rounded-lg bg-[var(--color-surface-muted)] p-3 space-y-2">
          <p className="text-sm font-semibold">Editing the future template. The finalized preview remains version {version}.</p>
          <label className="block text-xs">Reason to append a corrected version (optional)<input className="input w-full mt-1" value={correctionReason} onChange={event => setCorrectionReason(event.target.value)} /></label>
          <button type="button" className="btn btn-secondary" disabled={saving || correctionReason.trim().length < 5} onClick={async () => {
            const savedProfile = await save();
            if (!savedProfile) return;
            setSaving(true);
            const result = await classRequest<{ version: number }>(`/api/classes/invoices/${invoice.id}/cover-sheet`, "POST", { action: "append_correction", expectedVersion: version, expectedProfileUpdatedAt: savedProfile.updatedAt, reason: correctionReason });
            setSaving(false);
            if (!result.ok || !result.data) { setError(result.error ?? "Could not append the correction."); return; }
            const next = result.data.version; setVersions(current => [{ version: next, reason: correctionReason, createdAt: new Date().toISOString() }, ...current]);
            setVersion(next); setEditingFuture(false); setCorrectionReason("");
          }}>Append corrected cover version</button>
        </div> : null}
        {draft ? <p className="text-sm text-[var(--color-ink-soft)]">Preview this draft cover sheet before issuing the invoice. Issue the invoice to finalize and save its cover sheet.</p> : null}
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
        {!loading && canManage && !isVoid && !profile.lifePlanConfirmed ? (
          <p className="text-sm text-[var(--color-warn)]">Life Plan confirmation is required the first time this cover sheet is finalized.</p>
        ) : null}
        {saved ? <p className="text-sm font-medium text-[var(--color-success)]" role="status">Saved</p> : null}

        <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--color-rule)] pt-4">
          {canEditDocuments && canManage && !draft ? (
            <button type="button" className="btn btn-secondary" disabled={loading || saving || (isVoid && !finalized)} onClick={() => void saveAndOpenEditor()}>
              <FilePenLine className="h-4 w-4" aria-hidden />
              {saving ? "Saving..." : "Save & edit PDF"}
            </button>
          ) : <span />}
          <div className="flex flex-wrap justify-end gap-2">
            {canManage ? (
              <button type="button" className="btn btn-secondary" disabled={loading || saving || (isVoid && !finalized)} onClick={() => void saveAndPreview()}>
                <Eye className="h-4 w-4" aria-hidden />
                {saving ? "Saving..." : "Preview cover"}
              </button>
            ) : null}
            {canManage && !isVoid && (!finalized || editingFuture) ? (
              <button type="button" className="btn btn-secondary" disabled={loading || saving} onClick={() => void save()}>
                <Save className="h-4 w-4" aria-hidden />
                {saving ? "Saving..." : editingFuture ? "Save future template" : "Save profile"}
              </button>
            ) : null}
            {!draft ? <button type="button" className="btn btn-primary" disabled={loading || saving || (isVoid && !finalized)} onClick={() => void saveAndDownload()}>
              <Download className="h-4 w-4" aria-hidden />
              {saving ? "Saving..." : "Cover sheet"}
            </button> : null}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

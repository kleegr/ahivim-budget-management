import type { DocumentAccess } from "./document-access";
import { DOCUMENT_UUID, type DocumentRecord, type DocumentVersionRecord } from "@/lib/data/documents";
import { hasPortalCapability, hasPortalEmployeeCapability, hasPortalIndividualCapability, isPortalCapability } from "./portal-access";

export interface DocumentPublication {
  document_id: string;
  user_id: string;
  version_id: string;
  title: string;
  individual_id: string | null;
  employee_id: string | null;
  agency_id: string | null;
  scope_date: string | null;
  required_capabilities: string[];
  sanitized_pathname?: string;
  sanitized_byte_size?: string | number;
  sanitized_sha256?: string;
  sanitizer_version?: number;
  approved_at?: string;
}

export async function canReadPublication(access: DocumentAccess, publication: DocumentPublication): Promise<boolean> {
  const portal = access.portal;
  if (!portal || publication.user_id !== access.user.id || publication.required_capabilities.length === 0) return false;
  const required = ["documents.self.read", ...publication.required_capabilities];
  if (!required.every(isPortalCapability)) return false;
  if (publication.agency_id) {
    if (!publication.scope_date || !hasPortalCapability(portal, "people.agency.read", publication.agency_id)
      || !required.every((capability) => hasPortalCapability(portal, capability, publication.agency_id!))) return false;
    const table = publication.individual_id ? "agency_individuals" : "agency_employees";
    const column = publication.individual_id ? "individual_id" : "employee_id";
    const subject = publication.individual_id ?? publication.employee_id;
    if (!subject) return false;
    // Both the source date and today's roster must permit the exact subject.
    // Latest overlapping membership determines responsibility, so an older
    // permissive row cannot bypass a newer per-person restriction.
    for (const date of [publication.scope_date, null]) {
      const { rows } = await access.pool.query<{ manages_budget: boolean; bills_services: boolean }>(
        `SELECT ${publication.individual_id ? "manages_budget, bills_services" : "false AS manages_budget, true AS bills_services"}
          FROM ${table} WHERE agency_id = $1 AND ${column} = $2 AND is_active
          AND effective_from <= COALESCE($3::date, (now() AT TIME ZONE 'America/New_York')::date)
          AND (effective_to IS NULL OR effective_to >= COALESCE($3::date, (now() AT TIME ZONE 'America/New_York')::date))
          ORDER BY effective_from DESC, updated_at DESC, id DESC LIMIT 1`,
        [publication.agency_id, subject, date],
      );
      if (!rows[0]) return false;
      if (publication.individual_id && required.some((capability) => /^(hours_budgets|dollar_budgets)\./.test(capability)) && !rows[0].manages_budget) return false;
      if (publication.individual_id && required.some((capability) => /^(financials|settlements)\./.test(capability)) && !rows[0].bills_services) return false;
    }
    return true;
  }
  if (publication.individual_id) return required.every((capability) => hasPortalIndividualCapability(portal, publication.individual_id!, capability));
  if (publication.employee_id) return required.every((capability) => hasPortalEmployeeCapability(portal, publication.employee_id!, capability));
  return false;
}

export async function findDocumentPublication(access: DocumentAccess, documentId: string): Promise<DocumentPublication | null> {
  if (!DOCUMENT_UUID.test(documentId)) return null;
  const { rows } = await access.pool.query<DocumentPublication>(
    `SELECT publication.*, publication.approved_at::text AS approved_at FROM document_publications publication
      JOIN documents d ON d.id = publication.document_id
      JOIN document_versions v ON v.id = publication.version_id AND v.document_id = d.id
      WHERE publication.document_id = $1 AND publication.user_id = $2 AND d.status = 'active'
        AND publication.sanitizer_version = 1 AND v.export_mode = 'secure'`,
    [documentId, access.user.id],
  );
  const publication = rows[0];
  return publication && await canReadPublication(access, publication) ? publication : null;
}

/** Never include source titles, authors, filenames, descriptions, or lineage. */
export function publishedDocument(publication: DocumentPublication): DocumentRecord {
  return {
    id: publication.document_id, title: publication.title, description: null, category: "Approved document",
    status: "active", accessContext: null, originalVersionId: null, currentVersionId: publication.version_id,
    currentVersionNumber: 1, currentFilename: "document.pdf", currentByteSize: Number(publication.sanitized_byte_size),
    createdByUserId: "", createdBy: "", archivedAt: null, createdAt: publication.approved_at!, updatedAt: publication.approved_at!,
  };
}

export function safeDocumentVersion(version: DocumentVersionRecord, external = false) {
  return {
    id: version.id, documentId: version.documentId, versionNumber: external ? 1 : version.versionNumber,
    versionKind: "saved" as const, filename: external ? "document.pdf" : version.filename,
    byteSize: external ? null : version.byteSize, pageCount: external ? null : version.pageCount, createdAt: external ? null : version.createdAt,
  };
}

export async function listPublishedDocuments(access: DocumentAccess): Promise<DocumentRecord[]> {
  const { rows } = await access.pool.query<{ document_id: string }>(
    `SELECT document_id FROM document_publications WHERE user_id = $1`, [access.user.id],
  );
  const documents: DocumentRecord[] = [];
  for (const row of rows) {
    const publication = await findDocumentPublication(access, row.document_id);
    if (!publication) continue;
    documents.push(publishedDocument(publication));
  }
  return documents;
}

/** Navigation asks only whether an authorized, server-sanitized artifact exists. */
export async function hasReadableDocumentPublication(access: DocumentAccess): Promise<boolean> {
  const { rows } = await access.pool.query<DocumentPublication>(
    `SELECT publication.* FROM document_publications publication
      JOIN documents d ON d.id = publication.document_id
      WHERE publication.user_id = $1 AND d.status = 'active' AND publication.sanitizer_version = 1`, [access.user.id],
  );
  for (const publication of rows) if (await canReadPublication(access, publication)) return true;
  return false;
}

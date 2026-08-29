import type { PgLikePool } from "@/lib/import/commit";

export const DOCUMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DocumentStatus = "uploading" | "active" | "archived";
export type DocumentVersionKind = "original" | "saved" | "restored";
export type DocumentExportMode = "source" | "standard" | "secure";

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  versionNumber: number;
  versionKind: DocumentVersionKind;
  parentVersionId: string | null;
  restoredFromVersionId: string | null;
  exportMode: DocumentExportMode;
  editorSchemaVersion: number;
  editorState: Record<string, unknown>;
  pageCount: number | null;
  changeSummary: string | null;
  filename: string;
  byteSize: number;
  checksumSha256: string | null;
  createdByUserId: string;
  createdBy: string;
  createdAt: string;
}

export interface DocumentRecord {
  id: string;
  title: string;
  description: string | null;
  category: string;
  status: DocumentStatus;
  originalVersionId: string | null;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentFilename: string | null;
  currentByteSize: number | null;
  createdByUserId: string;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  title: string;
  description: string | null;
  category: string;
  status: DocumentStatus;
  original_version_id: string | null;
  current_version_id: string | null;
  current_version_number: number | null;
  current_filename: string | null;
  current_byte_size: string | null;
  created_by_user_id: string;
  created_by: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const DOCUMENT_SELECT = `
  SELECT d.id, d.title, d.description, d.category, d.status,
         d.original_version_id, d.current_version_id,
         current_version.version_number AS current_version_number,
         current_blob.filename AS current_filename,
         current_blob.byte_size::text AS current_byte_size,
         d.created_by_user_id, creator.display_name AS created_by,
         d.archived_at::text AS archived_at,
         d.created_at::text AS created_at, d.updated_at::text AS updated_at
    FROM documents d
    JOIN users creator ON creator.id = d.created_by_user_id
    LEFT JOIN document_versions current_version ON current_version.id = d.current_version_id
    LEFT JOIN document_blobs current_blob ON current_blob.id = current_version.output_blob_id
`;

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    originalVersionId: row.original_version_id,
    currentVersionId: row.current_version_id,
    currentVersionNumber: row.current_version_number,
    currentFilename: row.current_filename,
    currentByteSize: row.current_byte_size === null ? null : Number(row.current_byte_size),
    createdByUserId: row.created_by_user_id,
    createdBy: row.created_by,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listDocuments(
  pool: PgLikePool,
  filters: { status?: DocumentStatus | null; query?: string | null; limit?: number } = {},
): Promise<DocumentRecord[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.status) {
    params.push(filters.status);
    where.push(`d.status = $${params.length}`);
  } else {
    where.push(`d.status <> 'archived'`);
  }
  const query = filters.query?.trim();
  if (query) {
    params.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(d.title ILIKE $${params.length} ESCAPE '\\' OR d.description ILIKE $${params.length} ESCAPE '\\'
      OR d.category ILIKE $${params.length} ESCAPE '\\')`);
  }
  params.push(Math.min(200, Math.max(1, filters.limit ?? 100)));
  const { rows } = await pool.query<DocumentRow>(
    `${DOCUMENT_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY d.updated_at DESC, d.id
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toDocument);
}

export async function getDocument(pool: PgLikePool, id: string): Promise<DocumentRecord | null> {
  if (!DOCUMENT_UUID.test(id)) return null;
  const { rows } = await pool.query<DocumentRow>(`${DOCUMENT_SELECT} WHERE d.id = $1`, [id]);
  return rows[0] ? toDocument(rows[0]) : null;
}

interface VersionRow {
  id: string;
  document_id: string;
  version_number: number;
  version_kind: DocumentVersionKind;
  parent_version_id: string | null;
  restored_from_version_id: string | null;
  export_mode: DocumentExportMode;
  editor_schema_version: number;
  editor_state: Record<string, unknown>;
  page_count: number | null;
  change_summary: string | null;
  filename: string;
  byte_size: string;
  checksum_sha256: string | null;
  created_by_user_id: string;
  created_by: string;
  created_at: string;
}

const VERSION_SELECT = `
  SELECT version.id, version.document_id, version.version_number, version.version_kind,
         version.parent_version_id, version.restored_from_version_id, version.export_mode,
         version.editor_schema_version, version.editor_state, version.page_count,
         version.change_summary, blob.filename, blob.byte_size::text AS byte_size,
         blob.checksum_sha256, version.created_by_user_id,
         creator.display_name AS created_by, version.created_at::text AS created_at
    FROM document_versions version
    JOIN document_blobs blob ON blob.id = version.output_blob_id
    JOIN users creator ON creator.id = version.created_by_user_id
`;

const toVersion = (row: VersionRow): DocumentVersionRecord => ({
  id: row.id,
  documentId: row.document_id,
  versionNumber: row.version_number,
  versionKind: row.version_kind,
  parentVersionId: row.parent_version_id,
  restoredFromVersionId: row.restored_from_version_id,
  exportMode: row.export_mode,
  editorSchemaVersion: row.editor_schema_version,
  editorState: row.editor_state,
  pageCount: row.page_count,
  changeSummary: row.change_summary,
  filename: row.filename,
  byteSize: Number(row.byte_size),
  checksumSha256: row.checksum_sha256,
  createdByUserId: row.created_by_user_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export async function listDocumentVersions(pool: PgLikePool, documentId: string): Promise<DocumentVersionRecord[]> {
  if (!DOCUMENT_UUID.test(documentId)) return [];
  const { rows } = await pool.query<VersionRow>(
    `${VERSION_SELECT} WHERE version.document_id = $1 ORDER BY version.version_number DESC`,
    [documentId],
  );
  return rows.map(toVersion);
}

export async function getDocumentVersion(
  pool: PgLikePool,
  documentId: string,
  versionId: string,
): Promise<DocumentVersionRecord | null> {
  if (!DOCUMENT_UUID.test(documentId) || !DOCUMENT_UUID.test(versionId)) return null;
  const { rows } = await pool.query<VersionRow>(
    `${VERSION_SELECT} WHERE version.document_id = $1 AND version.id = $2`,
    [documentId, versionId],
  );
  return rows[0] ? toVersion(rows[0]) : null;
}

export interface DocumentFileRecord {
  versionId: string;
  documentId: string;
  pathname: string;
  etag: string;
  contentType: string;
  filename: string;
  byteSize: number;
}

export async function getDocumentVersionFile(
  pool: PgLikePool,
  documentId: string,
  versionId: string,
): Promise<DocumentFileRecord | null> {
  if (!DOCUMENT_UUID.test(documentId) || !DOCUMENT_UUID.test(versionId)) return null;
  const { rows } = await pool.query<{
    version_id: string;
    document_id: string;
    storage_pathname: string;
    storage_etag: string;
    content_type: string;
    filename: string;
    byte_size: string;
  }>(
    `SELECT version.id AS version_id, version.document_id,
            blob.storage_pathname, blob.storage_etag, blob.content_type,
            blob.filename, blob.byte_size::text AS byte_size
       FROM document_versions version
       JOIN document_blobs blob ON blob.id = version.output_blob_id
      WHERE version.document_id = $1 AND version.id = $2`,
    [documentId, versionId],
  );
  const row = rows[0];
  return row ? {
    versionId: row.version_id,
    documentId: row.document_id,
    pathname: row.storage_pathname,
    etag: row.storage_etag,
    contentType: row.content_type,
    filename: row.filename,
    byteSize: Number(row.byte_size),
  } : null;
}

export interface DocumentDraftRecord {
  documentId: string;
  userId: string;
  baseVersionId: string;
  revision: number;
  editorSchemaVersion: number;
  editorState: Record<string, unknown>;
  updatedAt: string;
}

export async function getDocumentDraft(
  pool: PgLikePool,
  documentId: string,
  userId: string,
): Promise<DocumentDraftRecord | null> {
  if (!DOCUMENT_UUID.test(documentId) || !DOCUMENT_UUID.test(userId)) return null;
  const { rows } = await pool.query<{
    document_id: string;
    user_id: string;
    base_version_id: string;
    revision: string;
    editor_schema_version: number;
    editor_state: Record<string, unknown>;
    updated_at: string;
  }>(
    `SELECT document_id, user_id, base_version_id, revision::text AS revision,
            editor_schema_version, editor_state, updated_at::text AS updated_at
       FROM document_drafts WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId],
  );
  const row = rows[0];
  return row ? {
    documentId: row.document_id,
    userId: row.user_id,
    baseVersionId: row.base_version_id,
    revision: Number(row.revision),
    editorSchemaVersion: row.editor_schema_version,
    editorState: row.editor_state,
    updatedAt: row.updated_at,
  } : null;
}

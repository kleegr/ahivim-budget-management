import {
  apiDocumentEditorUser,
  apiDocumentViewerUser,
  type DocumentAccess,
} from "@/lib/auth/document-access";
import { getDocument, type DocumentRecord, type DocumentFileRecord } from "@/lib/data/documents";
import { jsonError } from "@/lib/http";
import { canAccessDocumentSource } from "@/lib/auth/document-policy";
import { findDocumentPublication, publishedDocument } from "@/lib/auth/document-publications";

export type AccessibleDocumentResult =
  | { error: Response }
  | { access: DocumentAccess; document: DocumentRecord; canEdit: boolean; publishedVersionId: string | null; publishedFile?: DocumentFileRecord };

/** Deliberately collapses denied and missing document IDs into the same 404. */
export async function accessibleDocument(
  id: string,
  mode: "view" | "edit" = "view",
): Promise<AccessibleDocumentResult> {
  const access = mode === "edit"
    ? await apiDocumentEditorUser()
    : await apiDocumentViewerUser();
  if (!access) return { error: jsonError("That document was not found.", 404) };
  if (!access.external) {
    const document = await getDocument(access.pool, id);
    if (document && canAccessDocumentSource(access.scope, document)) {
      const canEdit = access.scope.canEditDocuments;
      if (mode === "view" || canEdit) return { access, document, canEdit, publishedVersionId: null };
    }
  }
  if (mode === "view") {
    const publication = await findDocumentPublication(access, id);
    if (publication) return {
      access, document: publishedDocument(publication), canEdit: false, publishedVersionId: publication.version_id,
      publishedFile: { documentId: id, versionId: publication.version_id, pathname: publication.sanitized_pathname!,
        etag: publication.sanitized_sha256!, contentType: "application/pdf", filename: "document.pdf", byteSize: Number(publication.sanitized_byte_size) },
    };
  }
  return { error: jsonError("That document was not found.", 404) };
}

import { apiDocumentEditorUser, type DocumentEditorAccess } from "@/lib/auth/document-access";
import { getDocument, type DocumentRecord } from "@/lib/data/documents";
import { jsonError } from "@/lib/http";

export type AccessibleDocumentResult =
  | { error: Response }
  | { access: DocumentEditorAccess; document: DocumentRecord };

/** Deliberately collapses denied and missing document IDs into the same 404. */
export async function accessibleDocument(id: string): Promise<AccessibleDocumentResult> {
  const access = await apiDocumentEditorUser();
  if (!access) return { error: jsonError("That document was not found.", 404) };
  const document = await getDocument(access.pool, id);
  return document
    ? { access, document }
    : { error: jsonError("That document was not found.", 404) };
}

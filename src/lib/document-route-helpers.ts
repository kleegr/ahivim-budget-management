import {
  apiDocumentEditorUser,
  apiDocumentViewerUser,
  type DocumentAccess,
} from "@/lib/auth/document-access";
import { getDocument, type DocumentRecord } from "@/lib/data/documents";
import { jsonError } from "@/lib/http";

export type AccessibleDocumentResult =
  | { error: Response }
  | { access: DocumentAccess; document: DocumentRecord };

/** Deliberately collapses denied and missing document IDs into the same 404. */
export async function accessibleDocument(
  id: string,
  mode: "view" | "edit" = "view",
): Promise<AccessibleDocumentResult> {
  const access = mode === "edit"
    ? await apiDocumentEditorUser()
    : await apiDocumentViewerUser();
  if (!access) return { error: jsonError("That document was not found.", 404) };
  const document = await getDocument(access.pool, id);
  return document
    ? { access, document }
    : { error: jsonError("That document was not found.", 404) };
}

import PdfEditorWorkspace from "@/components/documents/pdf-editor-workspace";
import DocumentViewerWorkspace from "@/components/documents/document-viewer-workspace";
import { requireDocumentViewerUser } from "@/lib/auth/document-access";
import { normalizePdfEditorSourcePath } from "@/lib/documents/pdf-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "PDF Editor - Ahivim Budget Management" };

export default async function PdfEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[]; document?: string | string[] }>;
}) {
  const access = await requireDocumentViewerUser();
  const params = await searchParams;
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  const documentId = Array.isArray(params.document) ? params.document[0] : params.document;
  const normalizedDocumentId = documentId && /^[0-9a-f-]{36}$/i.test(documentId) ? documentId : null;
  if (!access.scope.canEditDocuments) {
    return <DocumentViewerWorkspace documentId={normalizedDocumentId} />;
  }
  return (
    <PdfEditorWorkspace
      initialSourcePath={normalizePdfEditorSourcePath(source)}
      initialDocumentId={normalizedDocumentId}
    />
  );
}

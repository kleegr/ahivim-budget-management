import PdfEditorWorkspace from "@/components/documents/pdf-editor-workspace";
import { requireDocumentEditorUser } from "@/lib/auth/document-access";
import { normalizePdfEditorSourcePath } from "@/lib/documents/pdf-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "PDF Editor - Ahivim Budget Management" };

export default async function PdfEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[]; document?: string | string[] }>;
}) {
  await requireDocumentEditorUser();
  const params = await searchParams;
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  const documentId = Array.isArray(params.document) ? params.document[0] : params.document;
  const normalizedDocumentId = documentId && /^[0-9a-f-]{36}$/i.test(documentId) ? documentId : null;
  return (
    <PdfEditorWorkspace
      initialSourcePath={normalizePdfEditorSourcePath(source)}
      initialDocumentId={normalizedDocumentId}
    />
  );
}

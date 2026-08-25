import PdfEditorWorkspace from "@/components/documents/pdf-editor-workspace";
import { requireDocumentEditorUser } from "@/lib/auth/document-access";
import { normalizePdfEditorSourcePath } from "@/lib/documents/pdf-editor";

export const dynamic = "force-dynamic";

export default async function PdfEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  await requireDocumentEditorUser();
  const params = await searchParams;
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  return <PdfEditorWorkspace initialSourcePath={normalizePdfEditorSourcePath(source)} />;
}

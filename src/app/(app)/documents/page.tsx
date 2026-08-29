import DocumentLibrary from "@/components/documents/document-library";
import { requireDocumentEditorUser } from "@/lib/auth/document-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Documents - Ahivim Budget Management" };

export default async function DocumentsPage() {
  await requireDocumentEditorUser();
  return <DocumentLibrary />;
}

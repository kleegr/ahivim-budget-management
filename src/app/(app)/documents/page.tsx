import DocumentLibrary from "@/components/documents/document-library";
import { requireDocumentViewerUser } from "@/lib/auth/document-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Documents - Ahivim Budget Management" };

export default async function DocumentsPage() {
  const access = await requireDocumentViewerUser();
  return <DocumentLibrary canEdit={access.scope.canEditDocuments} />;
}

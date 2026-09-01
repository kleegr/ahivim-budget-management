import { describe, expect, it, vi } from "vitest";
import { getDocumentVersionFile } from "@/lib/data/documents";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "00000000-0000-4000-8000-000000000002";

const row = {
  version_id: VERSION_ID,
  document_id: DOCUMENT_ID,
  storage_pathname: "documents/source.pdf",
  storage_etag: "etag",
  content_type: "application/pdf",
  filename: "source.pdf",
  byte_size: "123",
};

describe("document version file selection", () => {
  it("selects the retained source blob for editable reopen requests", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });

    const file = await getDocumentVersionFile({ query } as never, DOCUMENT_ID, VERSION_ID, "source");

    expect(query.mock.calls[0]?.[0]).toContain("version.source_blob_id");
    expect(file).toMatchObject({ pathname: "documents/source.pdf", byteSize: 123 });
  });

  it("keeps the flattened output as the default download representation", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });

    await getDocumentVersionFile({ query } as never, DOCUMENT_ID, VERSION_ID);

    expect(query.mock.calls[0]?.[0]).toContain("version.output_blob_id");
  });
});

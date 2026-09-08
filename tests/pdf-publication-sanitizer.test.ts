import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream,
  StandardFonts, degrees, drawImage,
} from "pdf-lib";
import { sanitizePdfPublication } from "@/lib/documents/pdf-publication-sanitizer";

const PIXELS = new Uint8Array([255, 255, 255, 12, 34, 56]);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function fixture(options: { width?: number; height?: number; encoded?: Uint8Array; name?: string } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const image = PDFRawStream.of(pdf.context.obj({
    Type: "XObject", Subtype: "Image", Width: options.width ?? 2, Height: options.height ?? 1,
    BitsPerComponent: 8, ColorSpace: "DeviceRGB", Filter: "FlateDecode",
  }), options.encoded ?? deflateSync(PIXELS));
  const imageRef = pdf.context.register(image);
  const name = page.node.newXObject(options.name ?? "Image", imageRef);
  page.pushOperators(...drawImage(name, { x: 0, y: 0, width: 612, height: 792, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }));
  return { pdf, page, image, imageRef };
}

async function rebuiltImage(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = pdf.getPages()[0]!;
  const images = page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  const image = pdf.context.lookup(images.get(images.keys()[0]!)) as PDFRawStream;
  return { pdf, page, image, pixels: inflateSync(image.getContents()) };
}

describe("server reconstruction of approved PDF output", () => {
  it("accepts the actual embedPng/drawImage secure exporter format and preserves page dimensions/pixels", async () => {
    const pdf = await PDFDocument.create();
    const png = await pdf.embedPng(PNG);
    pdf.addPage([420.5, 600.25]).drawImage(png, { x: 0, y: 0, width: 420.5, height: 600.25 });
    const result = await sanitizePdfPublication(await pdf.save());
    const rebuilt = await rebuiltImage(result.bytes);
    expect(result.pageCount).toBe(1);
    expect(rebuilt.page.getSize()).toEqual({ width: 420.5, height: 600.25 });
    expect(rebuilt.pixels).toHaveLength(3);
    expect(rebuilt.image.dict.has(PDFName.of("SMask"))).toBe(false);
  });

  it("discards hidden metadata, attachments, orphan objects, names and compressed trailing payloads", async () => {
    const { pdf } = await fixture({ name: "SECRET_RESOURCE_NAME", encoded: Buffer.concat([deflateSync(PIXELS), Buffer.from("SECRET_TRAILING_DATA")]) });
    pdf.setTitle("SECRET_TITLE"); pdf.setAuthor("SECRET_EMPLOYEE_AUTHOR"); pdf.setSubject("SECRET_TAXES");
    await pdf.attach(Buffer.from("SECRET_ORIGINAL_PAYROLL"), "SECRET_PAYROLL.pdf", { description: "SECRET_EMPLOYEE_CHECK" });
    pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(pdf.context.stream("SECRET_XMP_METADATA", { Type: "Metadata", Subtype: "XML" })));
    pdf.context.register(pdf.context.stream("SECRET_ORPHANED_SOURCE"));
    const result = await sanitizePdfPublication(await pdf.save());
    const rebuilt = await rebuiltImage(result.bytes);
    expect([...rebuilt.pixels]).toEqual([...PIXELS]);
    expect(rebuilt.pdf.getTitle()).toBeUndefined();
    expect(rebuilt.pdf.getAuthor()).toBeUndefined();
    expect(rebuilt.pdf.catalog.has(PDFName.of("Names"))).toBe(false);
    expect(rebuilt.pdf.catalog.has(PDFName.of("Metadata"))).toBe(false);
    expect(Buffer.from(result.bytes).toString("latin1")).not.toContain("SECRET_");
    for (const [, object] of rebuilt.pdf.context.enumerateIndirectObjects()) {
      if (object instanceof PDFRawStream) expect(inflateSync(object.getContents()).toString("latin1")).not.toContain("SECRET_");
    }
  });

  it("rejects an ordinary text PDF even when a caller labels it secure", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("PRIVATE EMPLOYEE PAY", { font });
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it("can reconstruct an already sanitized artifact without changing pixels", async () => {
    const { pdf } = await fixture();
    const first = await sanitizePdfPublication(await pdf.save());
    const second = await sanitizePdfPublication(first.bytes);
    expect(second.pageCount).toBe(1);
    expect([...(await rebuiltImage(second.bytes)).pixels]).toEqual([...PIXELS]);
  });

  it("rejects documents with more than the supported page limit", async () => {
    const { pdf } = await fixture();
    for (let index = 1; index <= 120; index += 1) pdf.addPage();
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it("rejects hidden text added behind the visible raster", async () => {
    const { pdf, page } = await fixture();
    page.drawText("HIDDEN_PAYROLL_SENTINEL", { opacity: 0 });
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it.each(["OpenAction", "AA", "JavaScript", "OutputIntents", "Collection"])("rejects catalog %s that could change the reviewed output", async (kind) => {
    const { pdf } = await fixture();
    const action = pdf.context.obj({ S: "JavaScript", JS: "app.alert('SECRET_ACTION')" });
    if (kind === "JavaScript") pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({ JavaScript: { Names: ["action", action] } }));
    else pdf.catalog.set(PDFName.of(kind), action);
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it.each(["AA", "Group", "OC", "Trans", "PresSteps"])("rejects page %s actions and alternate rendering contexts", async (key) => {
    const { pdf, page } = await fixture();
    page.node.set(PDFName.of(key), pdf.context.obj({}));
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it.each(["SMask", "Mask", "Decode", "Alternates", "Metadata"])("rejects image %s instead of copying hidden image payloads", async (key) => {
    const { pdf, image, imageRef } = await fixture();
    image.dict.set(PDFName.of(key), imageRef);
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it.each(["crop", "rotation", "annotation", "form", "optional-content", "colorspace", "transparent-state", "extra-stream", "off-page"])("rejects an unsupported %s interpretation", async (kind) => {
    const { pdf, page } = await fixture();
    if (kind === "crop") page.setCropBox(10, 10, 100, 100);
    if (kind === "rotation") page.setRotation(degrees(90));
    if (kind === "annotation") page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Text", Contents: "SECRET_ANNOTATION" })));
    if (kind === "form") pdf.getForm().createTextField("SECRET_FORM");
    if (kind === "optional-content") pdf.catalog.set(PDFName.of("OCProperties"), pdf.context.obj({}));
    if (kind === "colorspace") page.node.Resources()!.set(PDFName.of("ColorSpace"), pdf.context.obj({ DefaultRGB: "SECRET_PROFILE" }));
    if (kind === "transparent-state") page.node.Resources()!.set(PDFName.of("ExtGState"), pdf.context.obj({ Hidden: {} }));
    if (kind === "extra-stream") page.node.addContentStream(pdf.context.register(pdf.context.flateStream("% SECRET_SOURCE")));
    if (kind === "off-page") page.setMediaBox(20, 20, 612, 792);
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it("rejects excess decompressed pixels and dimensions exceeding the workload bounds", async () => {
    const mismatch = await fixture({ encoded: deflateSync(new Uint8Array(100_000)) });
    await expect(sanitizePdfPublication(await mismatch.pdf.save())).rejects.toThrow("Secure PDF");
    const oversized = await fixture({ width: 24_000_001, height: 1 });
    await expect(sanitizePdfPublication(await oversized.pdf.save())).rejects.toThrow("Secure PDF");
    const invalid = await fixture();
    invalid.image.dict.set(PDFName.of("Width"), PDFNumber.of(0));
    await expect(sanitizePdfPublication(await invalid.pdf.save())).rejects.toThrow("Secure PDF");
  });

  it("rejects a decompression bomb in page instructions", async () => {
    const { pdf, page } = await fixture();
    page.node.set(PDFName.of("Contents"), pdf.context.obj([pdf.context.register(pdf.context.flateStream("q\n".repeat(100_000)))]));
    await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
  });

  it.each(["ObjStm", "XRef"])("bounds compressed %s structure before the library's decoder runs", async (kind) => {
    const { pdf } = await fixture();
    pdf.context.register(pdf.context.flateStream(new Uint8Array(3 * 1024 * 1024), {
      Type: kind, N: 0, First: 0, Size: 0, W: [1, 1, 1],
    }));
    await expect(sanitizePdfPublication(await pdf.save({ useObjectStreams: false }))).rejects.toThrow("Secure PDF");
  });

  it.each(["object-count", "index-count", "index-width"])("bounds structural %s loops even for tiny compressed streams", async (kind) => {
    const { pdf } = await fixture();
    pdf.context.register(pdf.context.flateStream("0 0", kind === "object-count"
      ? { Type: "ObjStm", N: 1_000_000_000, First: 0 }
      : { Type: "XRef", Size: 1, Index: [0, kind === "index-count" ? 1_000_000_000 : 1], W: [kind === "index-width" ? 1_000_000_000 : 1, 1, 1] }));
    await expect(sanitizePdfPublication(await pdf.save({ useObjectStreams: false }))).rejects.toThrow("Secure PDF");
  });

  it("caps aggregate structural entries across individually bounded streams", async () => {
    const { pdf } = await fixture();
    for (let index = 0; index < 2; index += 1) pdf.context.register(pdf.context.flateStream(new Uint8Array(18_000), {
      Type: "XRef", Size: 6_000, W: [1, 1, 1],
    }));
    await expect(sanitizePdfPublication(await pdf.save({ useObjectStreams: false }))).rejects.toThrow("Secure PDF");
  });

  it.each(["shared-offset", "overlap", "duplicate-id", "depth", "values", "embedded-stream", "extra-object"])("rejects %s within compressed objects before library delegation", async (kind) => {
    const { pdf } = await fixture();
    let header = "9000 0 ";
    let body = "0 ";
    if (kind === "shared-offset") { header = "9000 0 9001 0 "; body = `[${"0 ".repeat(10_000)}]`; }
    if (kind === "overlap") { header = "9000 0 9001 1 "; body = "[[0]]"; }
    if (kind === "duplicate-id") { header = "9000 0 9000 2 "; body = "0 0 "; }
    if (kind === "depth") body = `${"[".repeat(100)}0${"]".repeat(100)}`;
    if (kind === "values") body = `[${"0 ".repeat(100_001)}]`;
    if (kind === "embedded-stream") body = "<< /Length 0 >>\nstream\n\nendstream";
    if (kind === "extra-object") body = "0 1";
    pdf.context.register(pdf.context.flateStream(header + body, {
      Type: "ObjStm", N: header.trim().split(/\s+/).length / 2, First: header.length,
    }));
    await expect(sanitizePdfPublication(await pdf.save({ useObjectStreams: false }))).rejects.toThrow("Secure PDF");
  });

  it.each(["kid-cycle", "parent-cycle", "shared-kid"])("rejects a malformed %s page graph before recursive access", async (kind) => {
    const { pdf, page } = await fixture();
    const tree = pdf.catalog.Pages();
    if (kind === "kid-cycle") tree.Kids().push(pdf.catalog.get(PDFName.of("Pages"))!);
    if (kind === "parent-cycle") page.node.set(PDFName.of("Parent"), page.ref);
    if (kind === "shared-kid") tree.Kids().push(page.ref);
    await expect(sanitizePdfPublication(await pdf.save({ useObjectStreams: false, addDefaultPage: false }))).rejects.toThrow("Secure PDF");
  });

  it("rejects unknown image filters and uncompressed or multi-filter streams", async () => {
    for (const filter of [PDFName.of("DCTDecode"), undefined, PDFArray.withContext((await PDFDocument.create()).context)]) {
      const { pdf, image } = await fixture();
      if (filter) image.dict.set(PDFName.of("Filter"), filter);
      else image.dict.delete(PDFName.of("Filter"));
      await expect(sanitizePdfPublication(await pdf.save())).rejects.toThrow("Secure PDF");
    }
  });
});

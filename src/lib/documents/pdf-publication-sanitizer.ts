import { deflateSync, inflateSync } from "node:zlib";
import {
  PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFParser, PDFRawStream,
  degrees, drawImage,
} from "pdf-lib";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 120;
const MAX_PAGE_PIXELS = 24_000_000;
const MAX_TOTAL_PIXELS = 120_000_000;
const MAX_CONTENT_BYTES = 4_096;
const MAX_PAGE_POINTS = 14_400;
const MAX_STRUCTURE_BYTES = 2 * 1024 * 1024;
const MAX_STRUCTURE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_OBJECTS = 10_000;
const UNSUPPORTED = "This PDF is not a supported opaque secure export. Open it in the editor and save a new Secure PDF before approving it.";

function requireSafe(condition: unknown): asserts condition {
  if (!condition) throw new Error(UNSUPPORTED);
}

function onlyKeys(dict: PDFDict, keys: string[]): boolean {
  return dict.keys().every((key) => keys.includes(key.decodeText()));
}

function named(dict: PDFDict, key: string, value: string): boolean {
  return dict.lookupMaybe(PDFName.of(key), PDFName)?.decodeText() === value;
}

function numeric(dict: PDFDict, key: string): number | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
}

/** Decode only the exporter's single Flate filter, with a hard expansion bound. */
function inflate(stream: PDFRawStream, maximum: number): Uint8Array {
  requireSafe(named(stream.dict, "Filter", "FlateDecode") && !stream.dict.has(PDFName.of("DecodeParms")));
  return inflateSync(stream.getContents(), { maxOutputLength: maximum });
}

/** Bound structural streams before pdf-lib's parser inflates or loops over them. */
class PublicationPreflightParser extends PDFParser {
  private depth = 0;
  private values = 0;
  private structureBytes = 0;
  private structureObjects = 0;
  private embedded = false;

  private checkObjectStream(decoded: Uint8Array, count: number, first: number): void {
    const header = Buffer.from(decoded.subarray(0, first)).toString("latin1");
    requireSafe(count > 0 && /^[0-9\t\n\f\r ]+$/.test(header));
    const tokens = header.trim().split(/\s+/).map(Number);
    requireSafe(tokens.length === count * 2 && tokens.every(Number.isSafeInteger));
    const ids = new Set<number>();
    for (let index = 0; index < count; index += 1) {
      const id = tokens[index * 2]!;
      const offset = tokens[index * 2 + 1]!;
      const end = index + 1 < count ? tokens[index * 2 + 3]! : decoded.byteLength - first;
      requireSafe(id > 0 && id <= MAX_OBJECTS && !ids.has(id));
      ids.add(id);
      requireSafe(offset >= 0 && offset < end && end <= decoded.byteLength - first && (index > 0 || offset === 0));
      // pdf-lib's separate object-stream parser otherwise permits repeated or
      // overlapping offsets to amplify a single large object thousands of times.
      const parser = new PublicationPreflightParser(decoded.subarray(first + offset, first + end), 100, true);
      parser.embedded = true;
      parser.parseObject();
      parser.skipWhitespaceAndComments();
      requireSafe(parser.bytes.done());
      this.values += parser.values;
      requireSafe(this.values <= MAX_OBJECTS * 10);
    }
  }

  override parseObject(): PDFObject {
    requireSafe(++this.depth <= 64 && ++this.values <= MAX_OBJECTS * 10);
    try {
      const object = super.parseObject();
      if (!(object instanceof PDFRawStream)) return object;
      requireSafe(!this.embedded);
      const objectStream = named(object.dict, "Type", "ObjStm");
      const crossReference = named(object.dict, "Type", "XRef");
      if (!objectStream && !crossReference) return object;
      const decoded = inflate(object, MAX_STRUCTURE_BYTES);
      this.structureBytes += decoded.byteLength;
      requireSafe(this.structureBytes <= MAX_STRUCTURE_TOTAL_BYTES);
      const boundedInteger = (value: number | undefined, maximum = MAX_OBJECTS) =>
        value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
      if (objectStream) {
        requireSafe(boundedInteger(numeric(object.dict, "N")) && boundedInteger(numeric(object.dict, "First"), decoded.byteLength));
        this.structureObjects += numeric(object.dict, "N")!;
        requireSafe(this.structureObjects <= MAX_OBJECTS);
        this.checkObjectStream(decoded, numeric(object.dict, "N")!, numeric(object.dict, "First")!);
      } else {
        requireSafe(boundedInteger(numeric(object.dict, "Size")));
        const widths = object.dict.lookup(PDFName.of("W"), PDFArray);
        requireSafe(widths.size() === 3);
        for (let index = 0; index < 3; index += 1) requireSafe(boundedInteger(widths.lookup(index, PDFNumber).asNumber(), 8));
        const sections = object.dict.lookupMaybe(PDFName.of("Index"), PDFArray);
        let entries = numeric(object.dict, "Size")!;
        if (sections) {
          requireSafe(sections.size() <= MAX_OBJECTS * 2 && sections.size() % 2 === 0);
          entries = 0;
          for (let index = 0; index < sections.size(); index += 2) {
            const start = sections.lookup(index, PDFNumber).asNumber();
            const count = sections.lookup(index + 1, PDFNumber).asNumber();
            requireSafe(boundedInteger(start) && boundedInteger(count));
            entries += count;
          }
          requireSafe(entries <= MAX_OBJECTS);
        }
        this.structureObjects += entries;
      }
      requireSafe(this.structureObjects <= MAX_OBJECTS);
      return object;
    } finally { this.depth -= 1; }
  }
}

/** Reject cyclic/shared Kids and Parent links before recursive page accessors. */
function checkPageTree(context: PDFContext): void {
  requireSafe(context.enumerateIndirectObjects().length <= MAX_OBJECTS);
  const catalog = context.lookup(context.trailerInfo.Root, PDFDict);
  const root = catalog.lookup(PDFName.of("Pages"), PDFDict);
  const pending: { node: PDFDict; parent: PDFDict | null; depth: number }[] = [{ node: root, parent: null, depth: 0 }];
  const visited = new Set<PDFDict>();
  let pageCount = 0;
  while (pending.length) {
    const { node, parent, depth } = pending.pop()!;
    requireSafe(!visited.has(node) && depth <= 32 && visited.size < MAX_PAGES * 2 + 1);
    visited.add(node);
    requireSafe((node.lookupMaybe(PDFName.of("Parent"), PDFDict) ?? null) === parent);
    if (named(node, "Type", "Page")) {
      requireSafe(parent && ++pageCount <= MAX_PAGES);
    } else {
      requireSafe(named(node, "Type", "Pages"));
      const kids = node.lookup(PDFName.of("Kids"), PDFArray);
      requireSafe(kids.size() <= MAX_PAGES);
      for (let index = 0; index < kids.size(); index += 1) pending.push({ node: kids.lookup(index, PDFDict), parent: node, depth: depth + 1 });
    }
  }
  requireSafe(pageCount > 0);
}

/**
 * The browser exporter emits four matrices: translation, rotation, scale,
 * and skew. Require that exact program, including a full-page opaque image.
 * Text, clipping, transparency and hidden off-page drawing are never accepted.
 */
function fullPageImageName(contents: PDFRawStream, width: number, height: number): string {
  requireSafe(onlyKeys(contents.dict, ["Length", "Filter"]));
  const decoded = inflate(contents, MAX_CONTENT_BYTES);
  const text = Buffer.from(decoded).toString("latin1");
  requireSafe(/^[\t\n\f\r\x20-\x7e]*$/.test(text));
  const tokens = text.trim().split(/\s+/);
  requireSafe(tokens.length === 32 && tokens[0] === "q" && tokens[30] === "Do" && tokens[31] === "Q");
  const matrices = [[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], [width, 0, 0, height, 0, 0], [1, 0, 0, 1, 0, 0]];
  for (let index = 0; index < matrices.length; index += 1) {
    const offset = 1 + index * 7;
    requireSafe(tokens[offset + 6] === "cm");
    for (let component = 0; component < 6; component += 1) {
      const token = tokens[offset + component]!;
      requireSafe(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token));
      requireSafe(Number(token) === matrices[index]![component]);
    }
  }
  requireSafe(/^\/[A-Za-z0-9_-]{1,100}$/.test(tokens[29]!));
  return tokens[29]!.slice(1);
}

/**
 * A client-supplied `secure` flag is not an attestation. Accept only the
 * current exporter's opaque, full-page RGB raster format and reconstruct a
 * fresh document from exact decoded pixel buffers. No input object, compressed
 * stream, metadata, attachment, resource name or editor state is copied.
 * The Owner still approves the visible pixels and their recipient/category.
 */
export async function sanitizePdfPublication(input: Uint8Array): Promise<{ bytes: Uint8Array; pageCount: number }> {
  requireSafe(input.byteLength > 0 && input.byteLength <= MAX_INPUT_BYTES);
  try {
    // Use a per-call parser instance; never patch pdf-lib's global decoder.
    // The standard loader then reads these same bytes after bounded preflight.
    checkPageTree(await new PublicationPreflightParser(input, 100, true).parseDocument());
    const source = await PDFDocument.load(input, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
    // Accept the exporter's page catalog plus inert metadata/attachments only.
    // Actions, optional layers, output color intents and portfolios are not
    // part of the reviewed opaque-page format.
    requireSafe(!source.isEncrypted && onlyKeys(source.catalog, ["Type", "Pages", "Names", "Metadata", "AF"]));
    const names = source.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    requireSafe(!names?.has(PDFName.of("JavaScript")));
    const pages = source.getPages();
    requireSafe(pages.length > 0 && pages.length <= MAX_PAGES);
    const output = await PDFDocument.create({ updateMetadata: false });
    let totalPixels = 0;
    for (const page of pages) {
      // Actions and alternate rendering contexts could make the Owner's review
      // differ from the reconstructed page. Metadata alone is safe to discard.
      requireSafe(onlyKeys(page.node, ["Type", "Parent", "Resources", "MediaBox", "CropBox", "Rotate", "Contents", "Annots", "Metadata"]));
      const box = page.getMediaBox();
      const crop = page.getCropBox();
      requireSafe(box.x === 0 && box.y === 0 && box.width > 0 && box.height > 0
        && Number.isFinite(box.width) && Number.isFinite(box.height)
        && box.width <= MAX_PAGE_POINTS && box.height <= MAX_PAGE_POINTS
        && crop.x === box.x && crop.y === box.y && crop.width === box.width && crop.height === box.height
        && page.getRotation().angle === 0);
      requireSafe(!page.node.has(PDFName.of("UserUnit")) && !page.node.has(PDFName.of("TrimBox"))
        && !page.node.has(PDFName.of("ArtBox")) && !page.node.has(PDFName.of("BleedBox"))
        && (!page.node.Annots() || page.node.Annots()!.size() === 0));
      const content = page.node.Contents();
      requireSafe(content instanceof PDFArray && content.size() === 1);
      const stream = content.lookup(0);
      requireSafe(stream instanceof PDFRawStream);
      const name = fullPageImageName(stream, box.width, box.height);
      const resources = page.node.Resources();
      requireSafe(resources && onlyKeys(resources, ["XObject", "Font", "ExtGState"]));
      for (const key of ["Font", "ExtGState"]) {
        const value = resources.lookupMaybe(PDFName.of(key), PDFDict);
        requireSafe(!value || value.keys().length === 0);
      }
      const images = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
      requireSafe(images && images.keys().length === 1 && images.keys()[0]!.decodeText() === name);
      const image = source.context.lookup(images.get(PDFName.of(name)));
      requireSafe(image instanceof PDFRawStream && onlyKeys(image.dict, ["Type", "Subtype", "Width", "Height", "BitsPerComponent", "ColorSpace", "Filter", "Length"]));
      requireSafe(named(image.dict, "Type", "XObject") && named(image.dict, "Subtype", "Image")
        && named(image.dict, "ColorSpace", "DeviceRGB") && numeric(image.dict, "BitsPerComponent") === 8);
      const width = numeric(image.dict, "Width");
      const height = numeric(image.dict, "Height");
      requireSafe(width !== undefined && height !== undefined && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0);
      const pixels = width * height;
      totalPixels += pixels;
      requireSafe(Number.isSafeInteger(pixels) && pixels <= MAX_PAGE_PIXELS && totalPixels <= MAX_TOTAL_PIXELS);
      const rgb = inflate(image, pixels * 3);
      requireSafe(rgb.byteLength === pixels * 3);
      const rebuilt = PDFRawStream.of(output.context.obj({
        Type: "XObject", Subtype: "Image", Width: width, Height: height,
        BitsPerComponent: 8, ColorSpace: "DeviceRGB", Filter: "FlateDecode",
      }), deflateSync(rgb));
      const target = output.addPage([box.width, box.height]);
      const resource = target.node.newXObject("ApprovedImage", output.context.register(rebuilt));
      target.pushOperators(...drawImage(resource, {
        x: 0, y: 0, width: box.width, height: box.height,
        rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0),
      }));
    }
    const bytes = await output.save({ useObjectStreams: false, addDefaultPage: false });
    requireSafe(bytes.byteLength <= MAX_INPUT_BYTES);
    return { bytes, pageCount: pages.length };
  } catch {
    throw new Error(UNSUPPORTED);
  }
}

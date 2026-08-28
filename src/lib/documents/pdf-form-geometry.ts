import type {
  PdfFormRectangle,
  PdfFormWidgetDescriptor,
} from "./pdf-forms";

function normalizedWidgetRectangle(widget: PdfFormWidgetDescriptor): PdfFormRectangle | null {
  const page = widget.pageBox;
  if (!page || page.width <= 0 || page.height <= 0) return null;
  return {
    x: (widget.rectangle.x - page.x) / page.width,
    y: 1 - (widget.rectangle.y - page.y + widget.rectangle.height) / page.height,
    width: widget.rectangle.width / page.width,
    height: widget.rectangle.height / page.height,
  };
}

function rotateRectangle(rectangle: PdfFormRectangle, rotation: number): PdfFormRectangle {
  if (rotation === 90) {
    return {
      x: 1 - rectangle.y - rectangle.height,
      y: rectangle.x,
      width: rectangle.height,
      height: rectangle.width,
    };
  }
  if (rotation === 180) {
    return {
      x: 1 - rectangle.x - rectangle.width,
      y: 1 - rectangle.y - rectangle.height,
      width: rectangle.width,
      height: rectangle.height,
    };
  }
  if (rotation === 270) {
    return {
      x: rectangle.y,
      y: 1 - rectangle.x - rectangle.width,
      width: rectangle.height,
      height: rectangle.width,
    };
  }
  return rectangle;
}

function clampRectangle(rectangle: PdfFormRectangle): PdfFormRectangle {
  const x = Math.max(0, Math.min(1, rectangle.x));
  const y = Math.max(0, Math.min(1, rectangle.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(1 - x, rectangle.width)),
    height: Math.max(0, Math.min(1 - y, rectangle.height)),
  };
}

/** Converts a PDF bottom-left widget rectangle into the editor's top-left canvas coordinates. */
export function pdfFormWidgetCanvasRectangle(
  widget: PdfFormWidgetDescriptor,
  editorRotation = 0,
): PdfFormRectangle | null {
  const rectangle = normalizedWidgetRectangle(widget);
  if (!rectangle) return null;
  const rotation = ((widget.pageRotation + editorRotation) % 360 + 360) % 360;
  return clampRectangle(rotateRectangle(rectangle, rotation));
}

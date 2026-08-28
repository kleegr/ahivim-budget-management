export type PdfExportMode = "standard" | "secure";

export interface PdfExportModeConstraints {
  hasPageRotation: boolean;
  hasRotatedOverlay: boolean;
  pageOrderChanged: boolean;
  hasFormFields: boolean;
}

export interface PdfExportModeResolution {
  mode: PdfExportMode;
  forced: boolean;
  reason: string | null;
}

/**
 * Resolves the mode shown in the editor before export. Structural operations
 * that the vector exporter cannot preserve are never silently rasterized.
 */
export function resolvePdfExportMode(
  requestedMode: PdfExportMode,
  constraints: PdfExportModeConstraints,
): PdfExportModeResolution {
  if (constraints.pageOrderChanged && constraints.hasFormFields) {
    return {
      mode: "secure",
      forced: true,
      reason: "Reordering pages in a fillable PDF requires a flattened copy so fields stay on the correct pages.",
    };
  }
  if (constraints.hasPageRotation) {
    return {
      mode: "secure",
      forced: true,
      reason: "Rotated pages require a flattened copy because high-fidelity export cannot preserve that page transform.",
    };
  }
  if (constraints.hasRotatedOverlay) {
    return {
      mode: "secure",
      forced: true,
      reason: "Rotated editor items require a flattened copy to keep their on-page appearance exact.",
    };
  }
  return { mode: requestedMode, forced: false, reason: null };
}

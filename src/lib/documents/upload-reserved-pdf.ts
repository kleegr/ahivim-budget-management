import { upload } from "@vercel/blob/client";

export interface PdfUploadReservation {
  intentId: string;
  pathname: string;
  handleUploadUrl: string;
  transport?: "blob" | "local-test";
}

export async function uploadReservedPdf(reservation: PdfUploadReservation, file: File, onProgress?: (percentage: number) => void) {
  if (reservation.transport === "local-test") {
    const response = await fetch(reservation.handleUploadUrl, { method: "PUT", body: file,
      headers: { "content-type": "application/pdf", "x-document-pathname": reservation.pathname, "x-document-intent": reservation.intentId } });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? "The PDF upload failed. Try again."); }
    onProgress?.(100);
    return;
  }
  await upload(reservation.pathname, file, { access: "private", handleUploadUrl: reservation.handleUploadUrl,
    clientPayload: JSON.stringify({ intentId: reservation.intentId }), multipart: true,
    onUploadProgress: ({ percentage }) => onProgress?.(Math.round(percentage)) });
}

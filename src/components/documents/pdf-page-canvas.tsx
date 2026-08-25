"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";

function renderFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The page could not be rendered.";
}

export function PdfPageCanvas({
  document,
  pageNumber,
  scale,
  rotation = 0,
  className,
  onBaseSize,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation?: number;
  className?: string;
  onBaseSize?: (size: { width: number; height: number }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let task: RenderTask | null = null;
    setError(null);

    void (async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (!active || !canvasRef.current) return;
        const renderedRotation = (page.rotate + rotation + 360) % 360;
        const baseViewport = page.getViewport({ scale: 1, rotation: renderedRotation });
        const viewport = page.getViewport({ scale, rotation: renderedRotation });
        onBaseSize?.({ width: baseViewport.width, height: baseViewport.height });

        const canvas = canvasRef.current;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("This browser cannot create a PDF canvas.");
        const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        task = page.render({
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await task.promise;
        if (active) setError(null);
      } catch (renderError) {
        if (active && !(renderError instanceof Error && renderError.name === "RenderingCancelledException")) {
          setError(renderFailureMessage(renderError));
        }
      }
    })();

    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, onBaseSize, pageNumber, rotation, scale]);

  if (error) {
    return (
      <div className="grid min-h-72 place-items-center bg-white p-6 text-center text-sm text-[var(--color-danger)]" role="alert">
        {error}
      </div>
    );
  }

  return <canvas ref={canvasRef} className={className} role="img" aria-label={`PDF page ${pageNumber}`} />;
}

export function PdfThumbnailCanvas({
  document,
  pageNumber,
  rotation = 0,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  rotation?: number;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(pageNumber <= 3);
  const [scale, setScale] = useState(0.17);
  const updateScale = useCallback(({ width }: { width: number }) => {
    setScale((current) => {
      const next = Math.min(0.22, 96 / width);
      return current === next ? current : next;
    });
  }, []);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={holderRef} className="grid min-h-28 min-w-20 place-items-center overflow-hidden bg-white shadow-sm">
      {visible ? (
        <PdfPageCanvas
          document={document}
          pageNumber={pageNumber}
          scale={scale}
          rotation={rotation}
          onBaseSize={updateScale}
          className="block max-w-full"
        />
      ) : (
        <span className="text-xs text-[var(--color-ink-faint)]">{pageNumber}</span>
      )}
    </div>
  );
}

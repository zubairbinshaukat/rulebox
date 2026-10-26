import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { Button, IconButton } from "@rulebox/ui";
import IconZoomIn from "~icons/solar/magnifer-zoom-in-bold-duotone";
import IconZoomOut from "~icons/solar/magnifer-zoom-out-bold-duotone";

import { fileNameOf, rbfileUrl } from "./kind";
import {
  canvasScale,
  currentPage,
  fitWidthZoom,
  PAGE_GAP,
  stepPdfZoom,
  type PageSize,
} from "./pdfMath";
import { ViewerLoading, ViewerMessage } from "./ViewerMessage";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Zoom = { mode: "fit" } | { mode: "set"; value: number };

/**
 * A PDF with our own canvas viewer, not PDF.js's `viewer.html`. The file is
 * read from the `rbfile` protocol with range requests (nothing is loaded
 * ahead of need), only the pages near the window are drawn, each canvas is
 * capped at 6 megapixels, and everything is released when the window closes.
 */
export default function PdfViewer({ path }: { path: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [problem, setProblem] = useState<"locked" | "damaged" | null>(null);

  useEffect(() => {
    const task = pdfjs.getDocument({
      url: rbfileUrl(path),
      enableXfa: false,
      disableAutoFetch: true,
      rangeChunkSize: 1024 * 1024,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    let current = true;
    task.promise.then(
      (loaded) => {
        if (current) setDoc(loaded);
      },
      (error: unknown) => {
        if (current) {
          setProblem(error instanceof Error && error.name === "PasswordException" ? "locked" : "damaged");
        }
      },
    );
    return () => {
      current = false;
      // Frees the document, its pages and the worker.
      void task.destroy();
    };
  }, [path]);

  if (problem === "locked") return <ViewerMessage title="This PDF is locked." detail={fileNameOf(path)} />;
  if (problem === "damaged") return <ViewerMessage title="This PDF can't be shown." detail="The file may be damaged." />;
  if (!doc) return <ViewerLoading label="Loading PDF…" />;
  return <Pages doc={doc} path={path} />;
}

function Pages({ doc, path }: { doc: PDFDocumentProxy; path: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<Zoom>({ mode: "fit" });
  const [sizes, setSizes] = useState<Record<number, PageSize>>({});
  const [first, setFirst] = useState<PageSize | null>(null);
  const [page, setPage] = useState(1);

  // The first page sets the size every placeholder uses until its own page is known.
  useEffect(() => {
    let current = true;
    void doc.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      if (current) setFirst({ width: v.width, height: v.height });
      p.cleanup();
    });
    return () => {
      current = false;
    };
  }, [doc]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const zoomValue = zoom.mode === "set" ? zoom.value : first ? fitWidthZoom(width, first) : 1;
  const sizeOf = useCallback((n: number): PageSize => sizes[n] ?? first ?? { width: 612, height: 792 }, [sizes, first]);

  const onSize = useCallback((n: number, size: PageSize) => {
    setSizes((prev) => (prev[n]?.width === size.width && prev[n]?.height === size.height ? prev : { ...prev, [n]: size }));
  }, []);

  // Which page is in the middle of the window.
  const layout = useMemo(() => {
    const tops: number[] = [];
    const heights: number[] = [];
    let y = PAGE_GAP;
    for (let n = 1; n <= doc.numPages; n++) {
      const h = sizeOf(n).height * zoomValue;
      tops.push(y);
      heights.push(h);
      y += h + PAGE_GAP;
    }
    return { tops, heights, total: y };
  }, [doc.numPages, sizeOf, zoomValue]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    setPage(currentPage(layout.tops, layout.heights, element.scrollTop, element.clientHeight));
  }

  function goTo(n: number) {
    const target = Math.min(doc.numPages, Math.max(1, n));
    scroller.current?.scrollTo({ top: (layout.tops[target - 1] ?? 0) - PAGE_GAP });
  }

  function step(direction: 1 | -1) {
    setZoom({ mode: "set", value: stepPdfZoom(zoomValue, direction) });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "+" || event.key === "=") step(1);
    else if (event.key === "-" || event.key === "_") step(-1);
    else if (event.key === "0") setZoom({ mode: "fit" });
    else if (event.key === "PageDown") goTo(page + 1);
    else if (event.key === "PageUp") goTo(page - 1);
    else if (event.key === "Home") goTo(1);
    else if (event.key === "End") goTo(doc.numPages);
    else return;
    event.preventDefault();
  }

  return (
    <>
      <div style={toolbar} role="toolbar" aria-label="PDF">
        <span aria-live="polite" style={{ fontSize: 12.5, minWidth: 96 }}>
          Page {page} of {doc.numPages}
        </span>
        <IconButton label="Zoom out (-)" size={32} onClick={() => step(-1)} disabled={zoomValue <= 0.5}>
          <IconZoomOut width={16} height={16} />
        </IconButton>
        <span aria-live="polite" style={{ minWidth: 44, textAlign: "center", fontSize: 12.5 }}>
          {Math.round(zoomValue * 100)}%
        </span>
        <IconButton label="Zoom in (+)" size={32} onClick={() => step(1)} disabled={zoomValue >= 2}>
          <IconZoomIn width={16} height={16} />
        </IconButton>
        <Button type="button" variant="ghost" style={{ height: 32, padding: "0 14px", fontSize: 13 }} onClick={() => setZoom({ mode: "fit" })} aria-pressed={zoom.mode === "fit"}>
          Fit width
        </Button>
      </div>
      <div
        ref={scroller}
        tabIndex={0}
        role="document"
        aria-label={fileNameOf(path)}
        className="rb-focus-inset"
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        style={scrollArea}
      >
        <div style={{ position: "relative", height: layout.total, minWidth: Math.max(width, sizeOf(1).width * zoomValue + PAGE_GAP * 2) }}>
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PageSlot
              key={i + 1}
              doc={doc}
              number={i + 1}
              zoom={zoomValue}
              size={sizeOf(i + 1)}
              top={layout.tops[i] ?? 0}
              root={scroller}
              onSize={onSize}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function PageSlot({
  doc,
  number,
  zoom,
  size,
  top,
  root,
  onSize,
}: {
  doc: PDFDocumentProxy;
  number: number;
  zoom: number;
  size: PageSize;
  top: number;
  root: RefObject<HTMLDivElement | null>;
  onSize: (n: number, size: PageSize) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  // Only pages within about a window's height of the view are drawn.
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), {
      root: root.current,
      rootMargin: "100% 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const target = canvas.current;
    if (!near || !target) return;
    let current = true;
    let task: RenderTask | null = null;
    let loaded: PDFPageProxy | null = null;

    void doc
      .getPage(number)
      .then(async (p) => {
        loaded = p;
        const natural = p.getViewport({ scale: 1 });
        if (!current) return;
        onSize(number, { width: natural.width, height: natural.height });
        const scale = canvasScale(zoom, { width: natural.width, height: natural.height }, window.devicePixelRatio || 1);
        const viewport = p.getViewport({ scale });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        task = p.render({ canvas: target, viewport });
        await task.promise;
      })
      .catch(() => {
        // A cancelled render (scrolled away, zoom changed) is expected; a broken page stays blank.
      });

    return () => {
      current = false;
      task?.cancel();
      // Give the memory back: the canvas and what PDF.js cached for the page.
      target.width = 0;
      target.height = 0;
      loaded?.cleanup();
    };
  }, [near, doc, number, zoom, onSize]);

  return (
    <div
      ref={slot}
      style={{
        position: "absolute",
        left: "50%",
        top,
        width: size.width * zoom,
        height: size.height * zoom,
        transform: "translateX(-50%)",
        background: "#fff",
        boxShadow: "var(--rb-shadow-sm)",
      }}
    >
      {/* A drawn page has no text a screen reader can reach; it is named by its number. */}
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Page ${number}`}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
}

const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderBottom: "1px solid var(--rb-line)",
  background: "var(--rb-surface)",
};

const scrollArea: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  background: "var(--rb-bg)",
};


import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { IconButton } from "@rulebox/ui";
import type { ImageInfo } from "@rulebox/types";
import IconFit from "~icons/solar/full-screen-bold-duotone";
import IconActual from "~icons/solar/maximize-bold-duotone";
import IconZoomIn from "~icons/solar/magnifer-zoom-in-bold-duotone";
import IconZoomOut from "~icons/solar/magnifer-zoom-out-bold-duotone";

import { fileErrorText, isFileError } from "../files/errors";
import { call } from "../../lib/tauri";
import { fileNameOf, rbfileUrl } from "./kind";
import { ViewerLoading, ViewerMessage } from "./ViewerMessage";
import { centered, clampPan, fitScale, percent, stepZoom, zoomAt, type Placement, type Size } from "./zoom";

type Loaded = { info: ImageInfo } | { error: string; tooLarge: boolean } | null;

/**
 * A picture with zoom and pan. The page only moves one element with
 * `transform`, so a big image never causes layout work while it is dragged.
 */
export default function ImageViewer({ path }: { path: string }) {
  const [loaded, setLoaded] = useState<Loaded>(null);

  useEffect(() => {
    let current = true;
    void call("fs_image_info", { path }).then(
      (info) => {
        if (current) setLoaded({ info });
      },
      (error) => {
        if (current) {
          setLoaded({
            error: isFileError(error) && error.kind === "tooLarge" ? "This picture is too large to preview." : fileErrorText(error),
            tooLarge: isFileError(error) && error.kind === "tooLarge",
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [path]);

  if (!loaded) return <ViewerLoading />;
  if ("error" in loaded) return <ViewerMessage title={loaded.error} detail={fileNameOf(path)} />;
  return <Picture path={path} image={{ w: loaded.info.width, h: loaded.info.height }} />;
}

function Picture({ path, image }: { path: string; image: Size }) {
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Size>({ w: 0, h: 0 });
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; from: Placement } | null>(null);

  // The stage reports its size once it is laid out, and again when the window changes size.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setView({ w: element.clientWidth, h: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Until the person zooms or pans, the picture simply fits the window, at any window size.
  const auto: Placement | null = view.w > 0 && view.h > 0 ? centered(view, image, fitScale(view, image)) : null;
  const shown = placement ?? auto;
  const fit = () => setPlacement(null);
  const actual = () => setPlacement(centered(view, image, 1));

  function zoomStep(direction: 1 | -1) {
    if (!shown) return;
    const target = stepZoom(shown.scale, direction);
    setPlacement(clampPan(zoomAt(shown, target / shown.scale, { x: view.w / 2, y: view.h / 2 }), view, image));
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "+" || event.key === "=") zoomStep(1);
    else if (event.key === "-" || event.key === "_") zoomStep(-1);
    else if (event.key === "0") fit();
    else if (event.key === "1") actual();
    else return;
    event.preventDefault();
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !shown) return;
    stage.current?.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: shown };
  }

  function onPointerMove(event: PointerEvent) {
    const start = drag.current;
    if (!start) return;
    setPlacement(
      clampPan(
        { ...start.from, x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y },
        view,
        image,
      ),
    );
  }

  function onPointerUp() {
    drag.current = null;
  }

  function onWheel(event: WheelEvent) {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    if (!shown) return;
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    setPlacement(clampPan(zoomAt(shown, factor, { x: event.clientX - rect.left, y: event.clientY - rect.top }), view, image));
  }

  if (failed) {
    return <ViewerMessage title="This picture can't be shown." detail={fileNameOf(path)} />;
  }

  return (
    <>
      <div style={toolbar} role="toolbar" aria-label="Picture">
        <IconButton label="Zoom out (-)" size={32} onClick={() => zoomStep(-1)}>
          <IconZoomOut width={16} height={16} />
        </IconButton>
        <span aria-live="polite" style={{ minWidth: 48, textAlign: "center", fontSize: 12.5 }}>
          {shown ? percent(shown.scale) : ""}
        </span>
        <IconButton label="Zoom in (+)" size={32} onClick={() => zoomStep(1)}>
          <IconZoomIn width={16} height={16} />
        </IconButton>
        <IconButton label="Fit to window (0)" size={32} onClick={fit}>
          <IconFit width={16} height={16} />
        </IconButton>
        <IconButton label="Actual size (1)" size={32} onClick={actual}>
          <IconActual width={16} height={16} />
        </IconButton>
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--rb-muted)" }}>
          {image.w} × {image.h}
        </span>
      </div>
      <div
        ref={stage}
        tabIndex={0}
        aria-label={fileNameOf(path)}
        role="img"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={() => (shown && shown.scale !== 1 ? actual() : fit())}
        style={stageStyle}
      >
        {shown ? (
          <img
            src={rbfileUrl(path)}
            alt=""
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: image.w,
              height: image.h,
              maxWidth: "none",
              transformOrigin: "0 0",
              transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.scale})`,
              userSelect: "none",
              imageRendering: shown.scale > 2 ? "pixelated" : "auto",
            }}
          />
        ) : null}
      </div>
    </>
  );
}

const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 12px",
  borderBottom: "1px solid var(--rb-line)",
  background: "var(--rb-surface)",
};

const stageStyle: CSSProperties = {
  position: "relative",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  outline: "none",
  cursor: "grab",
  touchAction: "none",
  background: "var(--rb-bg)",
};

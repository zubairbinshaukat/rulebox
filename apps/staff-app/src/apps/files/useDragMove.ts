import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { canDropOn, DRAG_START_DISTANCE, dropDirOf, type DragState } from "./dragLogic";

/** Moving files by dragging: press on a row, move past a few pixels, release over a folder. */
export function useDragMove(onDrop: (dir: string, paths: string[]) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dropRef = useRef(onDrop);
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    dropRef.current = onDrop;
  }, [onDrop]);
  useEffect(() => () => cleanup.current?.(), []);

  const startDrag = useCallback((event: PointerEvent, paths: string[], label: string) => {
    if (event.button !== 0 || paths.length === 0) {
      return;
    }
    cleanup.current?.();
    const originX = event.clientX;
    const originY = event.clientY;
    let active = false;

    function targetAt(x: number, y: number): string | null {
      const dir = dropDirOf(document.elementFromPoint(x, y));
      return dir !== null && canDropOn(paths, dir) ? dir : null;
    }

    function onMove(e: globalThis.PointerEvent) {
      if (!active) {
        if (Math.hypot(e.clientX - originX, e.clientY - originY) < DRAG_START_DISTANCE) {
          return;
        }
        active = true;
      }
      setDrag({ paths, label, x: e.clientX, y: e.clientY, target: targetAt(e.clientX, e.clientY) });
    }

    function finish(drop: { x: number; y: number } | null) {
      stop();
      if (!active) {
        return;
      }
      // The click that follows the release must not select or open anything.
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setDrag(null);
      const dir = drop ? targetAt(drop.x, drop.y) : null;
      if (dir !== null) {
        dropRef.current(dir, paths);
      }
    }

    function onUp(e: globalThis.PointerEvent) {
      finish({ x: e.clientX, y: e.clientY });
    }
    function onCancel() {
      finish(null);
    }
    function onKey(e: KeyboardEvent) {
      // Escape cancels a drag in progress and does nothing else.
      if (e.key === "Escape" && active) {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    }
    function stop() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      cleanup.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    cleanup.current = () => {
      stop();
      setDrag(null);
    };
  }, []);

  /** True once, right after a drag ended: skip the click the release produces. */
  const consumeClick = useCallback(() => {
    const was = suppressClick.current;
    suppressClick.current = false;
    return was;
  }, []);

  return { drag, startDrag, consumeClick };
}

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import gsap from "gsap";
import { AppTile, Button } from "@rulebox/ui";
import type { AppEntry, TaskItem } from "@rulebox/types";
import IconLeft from "~icons/solar/alt-arrow-left-bold-duotone";
import IconRight from "~icons/solar/alt-arrow-right-bold-duotone";

import { useMotionLevel } from "../../lib/motion";
import { call } from "../../lib/tauri";
import { AppIcon } from "../appIcon";
import { hueFor } from "../appArt";
import { moveFocus, pageSlice, PAGE_GUTTER, solvePages, TILE_GAP, type PageLayout } from "./tileLayout";

/** A horizontal drag longer than this turns the page. */
const SWIPE_PX = 60;
/** A pointer that moved more than this was a drag, not a click. */
const DRAG_SLOP_PX = 8;
/** Wheel travel that turns the page, and the pause before the next turn. */
const WHEEL_PX = 60;
const WHEEL_PAUSE_MS = 450;

export interface AppGridProps {
  apps: AppEntry[];
  tasks?: TaskItem[];
  status: "idle" | "loading" | "ready" | "error";
  onRetry?: () => void;
}

export function AppGrid({ apps, tasks = [], status, onRetry }: AppGridProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 800, h: 500 });
  // The measured element changes between the loading, empty and tiles views.
  const view = status === "ready" && apps.length > 0 ? "tiles" : status;

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setArea({ w: box.width, h: box.height });
    });
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [view]);

  const layout = solvePages(area, apps.length);

  if (status === "loading" || status === "idle") {
    return (
      <div ref={areaRef} style={areaStyle} aria-busy="true">
        <div role="status" className="rb-sr-only">
          Loading your apps
        </div>
        <Skeleton layout={layout} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div ref={areaRef} role="alert" style={{ ...areaStyle, ...messageStyle }}>
        <div style={{ fontSize: 18, fontWeight: 500 }}>Can&apos;t load your apps right now.</div>
        <Button type="button" onClick={() => onRetry?.()}>
          Try again
        </Button>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div ref={areaRef} style={{ ...areaStyle, ...messageStyle, maxWidth: 420 }}>
        <div style={{ fontSize: 20, fontWeight: 500 }}>No apps assigned yet</div>
        <p style={{ margin: 0, color: "var(--rb-muted)", lineHeight: 1.45 }}>
          Your administrator has not assigned any apps to you on this PC. Ask them if you need
          something.
        </p>
        <Button type="button" onClick={() => onRetry?.()}>
          Check again
        </Button>
      </div>
    );
  }

  return (
    <div ref={areaRef} style={areaStyle}>
      <PagedTiles apps={apps} tasks={tasks} layout={layout} />
    </div>
  );
}

function PagedTiles({ apps, tasks, layout }: { apps: AppEntry[]; tasks: TaskItem[]; layout: PageLayout }) {
  const level = useMotionLevel();
  const gridRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  // The tile that Tab lands on (one tab stop for the whole grid; the arrow keys do the rest).
  const [tabStop, setTabStop] = useState(0);
  const lastPage = layout.pages - 1;
  const shown = Math.min(page, lastPage);
  // The direction of the last turn, for the slide-in (1 = forward).
  const turn = useRef<{ dir: number; page: number } | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; dx: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const wheel = useRef({ travel: 0, lockedUntil: 0 });

  // Fewer pages after a resize or a catalogue change: `shown` stays on the last one.
  function focusTile(local: number) {
    gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-tile] button")[local]?.focus();
  }

  function goTo(next: number) {
    const target = Math.min(Math.max(0, next), lastPage);
    if (target === shown) return;
    turn.current = { dir: target > shown ? 1 : -1, page: target };
    setPage(target);
  }

  // The new page slides in from the side it came from (transform and opacity only).
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const pending = turn.current;
    if (!grid || !pending || pending.page !== shown) return;
    turn.current = null;
    const tween =
      level === "full"
        ? gsap.fromTo(
            grid,
            { x: pending.dir * 56, autoAlpha: 0 },
            { x: 0, autoAlpha: 1, duration: 0.34, ease: "power3.out", clearProps: "transform,opacity,visibility" },
          )
        : gsap.fromTo(grid, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.15, clearProps: "opacity,visibility" });
    return () => {
      tween.kill();
    };
  }, [shown, level]);

  // Keyboard focus that moved onto another page lands on its tile once it is drawn.
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    focusTile(index - shown * layout.perPage);
  }, [shown, layout.perPage]);

  async function launch(id: string) {
    if (suppressClick.current) return;
    try {
      await call("launch_app", { id });
    } catch {
      // The command may be missing mid-rebuild; nothing else to do.
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      goTo(shown + (event.key === "PageDown" ? 1 : -1));
      return;
    }
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const;
    const key = keys.find((k) => k === event.key);
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-tile]")?.dataset.index;
    if (!key || from === undefined) return;
    event.preventDefault();
    const next = moveFocus(Number(from), key, layout.cols, apps.length);
    // Up and down stay within a page; left, right, Home and End run through all of them.
    if ((key === "ArrowUp" || key === "ArrowDown") && Math.floor(next / layout.perPage) !== shown) {
      return;
    }
    const nextPage = Math.floor(next / layout.perPage);
    if (nextPage !== shown) {
      pendingFocus.current = next;
      goTo(nextPage);
    } else {
      focusTile(next - shown * layout.perPage);
    }
  }

  // Swipe: the page follows the finger a little, and turns past SWIPE_PX.
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!layout.paged || !event.isPrimary || event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dragging: false };
    suppressClick.current = false;
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    d.dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.dragging && Math.abs(d.dx) > DRAG_SLOP_PX && Math.abs(d.dx) > Math.abs(dy)) {
      d.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (d.dragging && gridRef.current && level === "full") {
      // Resist at the first and last page.
      const atEdge = (d.dx > 0 && shown === 0) || (d.dx < 0 && shown === lastPage);
      gsap.set(gridRef.current, { x: d.dx * (atEdge ? 0.15 : 0.35) });
    }
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== event.pointerId || !d.dragging) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    const target = Math.abs(d.dx) > SWIPE_PX ? shown + (d.dx < 0 ? 1 : -1) : shown;
    if (target !== shown && target >= 0 && target <= lastPage) {
      goTo(target);
    } else if (gridRef.current) {
      gsap.to(gridRef.current, { x: 0, duration: level === "full" ? 0.25 : 0, ease: "power2.out", clearProps: "transform" });
    }
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    if (!layout.paged) return;
    const now = performance.now();
    const state = wheel.current;
    if (now < state.lockedUntil) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    state.travel += delta;
    if (Math.abs(state.travel) >= WHEEL_PX) {
      const dir = state.travel > 0 ? 1 : -1;
      state.travel = 0;
      state.lockedUntil = now + WHEEL_PAUSE_MS;
      goTo(shown + dir);
    }
  }

  const running = new Set(tasks.map((task) => task.appId).filter((id): id is string => Boolean(id)));
  const onPage = pageSlice(apps, shown, layout.perPage);
  const firstOnPage = shown * layout.perPage;
  // A remembered tile on another page does not count: the page's first tile takes the tab stop.
  const reachable =
    tabStop >= firstOnPage && tabStop < firstOnPage + onPage.length ? tabStop : firstOnPage;
  const gridHeight = layout.rows * layout.tile.h + (layout.rows - 1) * TILE_GAP;
  const gutter = layout.paged ? PAGE_GUTTER : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%", minHeight: 0 }}>
      <div
        role="region"
        aria-roledescription="carousel"
        aria-label="Your apps"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ display: "flex", alignItems: "center", touchAction: "pan-y", userSelect: "none" }}
      >
        {layout.paged ? (
          <div style={{ width: gutter, flex: "none", display: "flex", justifyContent: "flex-start" }}>
            <button
              type="button"
              className="rb-page-arrow"
              aria-label="Previous page"
              aria-disabled={shown === 0}
              onClick={() => goTo(shown - 1)}
            >
              <IconLeft width="1em" height="1em" />
            </button>
          </div>
        ) : null}
        <div
          ref={gridRef}
          role="list"
          aria-label="Apps"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${layout.cols}, ${layout.tile.w}px)`,
            gridAutoRows: `${layout.tile.h}px`,
            gap: TILE_GAP,
            height: layout.paged ? gridHeight : undefined,
            alignContent: "start",
          }}
        >
          {onPage.map((app, i) => (
            <div key={app.id} role="listitem" data-tile data-index={firstOnPage + i}>
              <AppTile
                tabIndex={firstOnPage + i === reachable ? 0 : -1}
                onFocus={() => setTabStop(firstOnPage + i)}
                name={app.name}
                description={app.description ?? undefined}
                imageSrc={app.iconUrl ?? undefined}
                glyph={<AppIcon app={app} />}
                hue={hueFor(app)}
                badge={app.badge ?? undefined}
                running={running.has(app.id)}
                size={layout.tier}
                onClick={() => void launch(app.id)}
                style={{ width: "100%", height: "100%" }}
              />
            </div>
          ))}
        </div>
        {layout.paged ? (
          <div style={{ width: gutter, flex: "none", display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="rb-page-arrow"
              aria-label="Next page"
              aria-disabled={shown === lastPage}
              onClick={() => goTo(shown + 1)}
            >
              <IconRight width="1em" height="1em" />
            </button>
          </div>
        ) : null}
      </div>
      {layout.paged ? (
        <div
          className="rb-pager"
          style={{ width: layout.cols * layout.tile.w + (layout.cols - 1) * TILE_GAP + 2 * gutter }}
        >
          <div className="rb-pager__dots" role="group" aria-label="Pages">
            {Array.from({ length: layout.pages }, (_, i) => (
              <button
                key={i}
                type="button"
                className="rb-pager__dot"
                aria-label={`Page ${i + 1} of ${layout.pages}`}
                aria-current={i === shown ? "page" : undefined}
                onClick={() => goTo(i)}
              />
            ))}
            <span
              className="rb-pager__thumb"
              aria-hidden
              style={{ ["--rb-pager-index" as string]: shown }}
            />
          </div>
          <div className="rb-pager__caption" aria-live="polite">
            Page {shown + 1} of {layout.pages} · {apps.length} apps
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Skeleton({ layout }: { layout: PageLayout }) {
  const level = useMotionLevel();
  const n = Math.max(3, Math.min(8, layout.perPage));
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${layout.cols}, ${layout.tile.w}px)`,
        gap: TILE_GAP,
      }}
    >
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          aria-hidden
          style={{
            width: layout.tile.w,
            height: layout.tile.h,
            borderRadius: 22,
            background: "var(--rb-surface)",
            opacity: level === "fade" ? 0.7 : undefined,
            animation: level === "fade" ? undefined : "rb-pulse 1.2s ease-in-out infinite",
          }}
        />
      ))}
    </div>
  );
}

// Not clipped: a hovered tile lifts and its shadow grows past the grid's box.
const areaStyle = { flex: 1, minHeight: 0, minWidth: 0 } as const;

const messageStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "center",
  gap: 12,
  color: "var(--rb-ink)",
} as const;

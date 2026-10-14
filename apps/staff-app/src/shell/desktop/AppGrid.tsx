import { useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { AppTile, Button } from "@rulebox/ui";
import type { AppEntry } from "@rulebox/types";

import { useMotionLevel } from "../../lib/motion";
import { call } from "../../lib/tauri";
import { AppIcon } from "../appIcon";
import { solveTiles, type TileTier } from "./tileLayout";

gsap.registerPlugin(Flip);

const GAP = 18;

export interface AppGridProps {
  apps: AppEntry[];
  status: "idle" | "loading" | "ready" | "error";
  onRetry?: () => void;
}

export function AppGrid({ apps, status, onRetry }: AppGridProps) {
  const level = useMotionLevel();
  const areaRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 800, h: 500 });
  const flipState = useRef<Flip.FlipState | null>(null);
  const layoutKey = useRef<{ cols: number; tier: TileTier } | null>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const next = { w: box.width, h: box.height };
      const nextSolve = solveTiles(next, apps.length, GAP);
      const prev = layoutKey.current;
      if (
        level === "full" &&
        gridRef.current &&
        prev &&
        (prev.cols !== nextSolve.cols || prev.tier !== nextSolve.tier)
      ) {
        flipState.current = Flip.getState(gridRef.current.querySelectorAll("[data-tile]"));
      }
      setArea(next);
    });
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [apps.length, level]);

  const solved = solveTiles(area, apps.length, GAP);

  useLayoutEffect(() => {
    layoutKey.current = { cols: solved.cols, tier: solved.tier };
    if (level !== "full" || !flipState.current) return;
    const state = flipState.current;
    flipState.current = null;
    Flip.from(state, {
      duration: 0.35,
      ease: "power2.out",
      absolute: true,
      nested: true,
    });
  }, [solved.cols, solved.tier, level, apps.length]);

  async function onLaunch(id: string) {
    try {
      await call("launch_app", { id });
    } catch {
      // Command may be missing mid-rebuild; ignore.
    }
  }

  if (status === "loading" || status === "idle") {
    const n = Math.max(3, Math.min(8, solved.cols * 2));
    return (
      <div ref={areaRef} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${solved.cols}, ${solved.tile.w}px)`,
            gap: GAP,
            justifyContent: "start",
          }}
        >
          {Array.from({ length: n }, (_, i) => (
            <div
              key={i}
              aria-hidden
              style={{
                width: solved.tile.w,
                height: solved.tile.h,
                borderRadius: 18,
                background: "var(--rb-surface)",
                opacity: level === "fade" ? 0.7 : undefined,
                animation: level === "fade" ? undefined : "rb-pulse 1.2s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        ref={areaRef}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          gap: 12,
          color: "var(--rb-ink)",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 500 }}>Can&apos;t load your apps right now.</div>
        <Button type="button" onClick={() => onRetry?.()}>
          Try again
        </Button>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div
        ref={areaRef}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          gap: 12,
          maxWidth: 420,
          color: "var(--rb-ink)",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 500 }}>No apps assigned yet</div>
        <p style={{ margin: 0, color: "var(--rb-muted)", lineHeight: 1.45 }}>
          Your administrator has not assigned any apps to you on this PC. Ask them if you
          need something.
        </p>
        <Button type="button" onClick={() => onRetry?.()}>
          Check again
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={areaRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: solved.scroll ? "auto" : "hidden",
      }}
    >
      <div
        ref={gridRef}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${solved.cols}, ${solved.tile.w}px)`,
          gap: GAP,
          justifyContent: "start",
          alignContent: "start",
        }}
      >
        {apps.map((app) => (
          <div key={app.id} data-tile style={{ width: solved.tile.w, height: solved.tile.h }}>
            <AppTile
              name={app.name}
              description={app.description ?? undefined}
              icon={<AppIcon app={app} />}
              badge={app.badge ?? undefined}
              hue={app.hue ?? undefined}
              size={solved.tier}
              onClick={() => void onLaunch(app.id)}
              style={{ width: "100%", height: "100%" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

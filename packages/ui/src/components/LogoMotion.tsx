import { useLayoutEffect, useRef, type AnimationEvent, type CSSProperties } from "react";
import { LOGO_BOX, LOGO_CELLS, LOGO_GRID, LOGO_VIEWBOX } from "../brand/geometry";

/**
 * Animated logo (PRD 25.5). All motion is CSS in logo-motion.css: no JS runs
 * per frame, and the tiles animate only transform and opacity so they stay on
 * the compositor while the app is still loading. Use <LogoMark> wherever the
 * logo does not move.
 */

export type LogoAnimation = "none" | "splash" | "loading" | "open" | "lock";

export interface LogoMotionProps {
  /** To replay the same animation, change the component's `key`. */
  animation?: LogoAnimation;
  /** Mark size in px. The wordmark scales with it. */
  size?: number;
  wordmark?: boolean;
  /** Line under the wordmark; `null` hides it. */
  tagline?: string | null;
  /** "open" only: the green flood now covers the screen; swap in the desktop. */
  onCovered?: () => void;
  /** The animation finished ("loading" never does). */
  onDone?: () => void;
  className?: string;
}

const WORD = [..."rulebox"];
const pct = (units: number) => `${(units / LOGO_VIEWBOX) * 100}%`;

/** Small seeded PRNG so the "random" staggers are the same on every run. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TILES = (() => {
  const rand = prng(7);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const maxDist = Math.hypot(4, 3);
  const offCount = LOGO_CELLS.filter((c) => !c.on).length;
  const legCount = LOGO_CELLS.filter((c) => c.leg).length;
  let off = 0;
  let leg = 0;
  let row = -1;
  let inRow = 0;
  let legInRow = 0;

  return LOGO_CELLS.map((c) => {
    if (c.row !== row) {
      row = c.row;
      inRow = 0;
      legInRow = 0;
    }
    const style = {
      left: pct(LOGO_GRID.x0 + c.col * LOGO_GRID.pitch),
      top: pct(LOGO_GRID.y0 + c.row * LOGO_GRID.pitch),
      "--r": c.row,
      // Position in the row's stagger (R tiles and leg tiles stagger separately).
      "--k": c.leg ? legInRow++ : c.on ? inRow++ : 0,
      // Distance from the grid centre, 0..1.
      "--d": r2(Math.hypot(c.row - 4, c.col - 3) / maxDist),
      // Random order, 0..1.
      "--q": r2(rand()),
      "--dx": Math.round(rand() * 240 - 120),
      "--dy": Math.round(rand() * 240 - 120),
      "--rot": Math.round(rand() * 360 - 180),
      // Blocked tiles leave last-to-first; leg tiles run first-to-last.
      "--b": c.on ? 0 : offCount - 1 - off++,
      "--l": c.leg ? leg++ : 0,
    } as CSSProperties;
    const kind = c.leg ? (leg === legCount ? "is-on is-leg is-end" : "is-on is-leg") : c.on ? "is-on" : "is-off";
    return { key: `${c.row}-${c.col}`, className: `rb-lm-cell ${kind}`, style };
  });
})();

export function LogoMotion({
  animation = "none",
  size = 170,
  wordmark = true,
  tagline = "Only what you allow",
  onCovered,
  onDone,
  className,
}: LogoMotionProps) {
  const root = useRef<HTMLDivElement>(null);

  // The last leg tile grows into the flood; size it to reach every corner of the window.
  useLayoutEffect(() => {
    const el = root.current;
    const mark = el?.firstElementChild;
    if (animation !== "open" || !el || !mark) return;
    const box = mark.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const far = Math.hypot(Math.max(cx, window.innerWidth - cx), Math.max(cy, window.innerHeight - cy));
    const tile = (box.width * LOGO_GRID.cell) / LOGO_VIEWBOX;
    // 1.7: the tile's rounded corners reach only ~0.59 of its width along the diagonal.
    el.style.setProperty("--rb-lm-flood", String(Math.ceil((far * 1.7) / tile)));
  }, [animation, size]);

  function onAnimationEnd(e: AnimationEvent<HTMLDivElement>) {
    switch (e.animationName) {
      case "rb-lm-flood-grow":
        onCovered?.();
        break;
      case "rb-lm-fade-out":
        onCovered?.();
        onDone?.();
        break;
      case "rb-lm-box-kick":
        if (!wordmark) onDone?.();
        break;
      case "rb-lm-tag-in":
      case "rb-lm-flood-out":
      case "rb-lm-fade-in":
        onDone?.();
        break;
    }
  }

  return (
    <div
      ref={root}
      className={["rb-lm", className ?? ""].filter(Boolean).join(" ")}
      data-anim={animation}
      style={{ "--rb-lm-size": `${size}px` } as CSSProperties}
      role="img"
      aria-label="Rulebox"
      onAnimationEnd={onAnimationEnd}
    >
      <div className="rb-lm-mark" aria-hidden="true">
        <svg className="rb-lm-box" viewBox={`0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`}>
          <rect
            x={LOGO_BOX.x}
            y={LOGO_BOX.y}
            width={LOGO_BOX.size}
            height={LOGO_BOX.size}
            rx={LOGO_BOX.rx}
            strokeWidth={LOGO_BOX.stroke}
            pathLength={100}
          />
        </svg>
        {TILES.map((t) => (
          <i key={t.key} className={t.className} style={t.style} />
        ))}
        <div className="rb-lm-clip">
          <div className="rb-lm-scan" />
        </div>
      </div>
      {wordmark && (
        <div className="rb-lm-word" aria-hidden="true">
          {WORD.map((ch, n) => (
            <span key={n} className="rb-lm-letter" style={{ "--n": n } as CSSProperties}>
              {ch}
            </span>
          ))}
          <span className="rb-lm-dot" style={{ "--n": WORD.length } as CSSProperties} />
        </div>
      )}
      {wordmark && tagline && (
        <div className="rb-lm-tag" aria-hidden="true" style={{ "--n": WORD.length + 1 } as CSSProperties}>
          {tagline}
        </div>
      )}
    </div>
  );
}

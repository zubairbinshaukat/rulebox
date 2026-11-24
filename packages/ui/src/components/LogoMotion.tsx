import { useId, useLayoutEffect, useRef, type AnimationEvent, type CSSProperties } from "react";
import { CUBE_MOTION } from "../brand/cube-motion";

/**
 * Animated logo (PRD 25.5). All motion is CSS in logo-motion.css: no JS runs
 * per frame, and every layer animates only transform and opacity so it stays
 * on the compositor while the app is still loading. Use <LogoMark> wherever
 * the logo does not move.
 *
 * Layers (made by `pnpm gen:brand` from the master render):
 *   body   the cube with the keyhole dark
 *   light  the keyhole light alone; light over body is the render
 *   bloom  a warm radial glow over the keyhole (CSS gradient, no blur filter)
 *   sheen  a light band masked to the cube's highlights
 *   door   the keyhole as a flat shape of warm light; open/lock zoom through it
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
  /** "open" only: the keyhole light now covers the screen; swap in the desktop. */
  onCovered?: () => void;
  /** The animation finished ("loading" never does). */
  onDone?: () => void;
  className?: string;
}

const WORD = [..."rulebox"];
/** The keyhole's round top, in units of the 100-unit mark box (= % of the mark). */
const K = CUBE_MOTION.circle;

/** Layer geometry, in % of the mark (set once; the CSS reads the custom properties). */
const MARK_VARS = {
  "--rb-lm-kx": `${K.cx}%`,
  "--rb-lm-ky": `${K.cy}%`,
  "--rb-lm-gx": `${CUBE_MOTION.glow.x}%`,
  "--rb-lm-gy": `${CUBE_MOTION.glow.y}%`,
} as CSSProperties;

const LIGHT_BOX: CSSProperties = {
  left: `${CUBE_MOTION.keyhole.left}%`,
  top: `${CUBE_MOTION.keyhole.top}%`,
  width: `${CUBE_MOTION.keyhole.width}%`,
  height: `${CUBE_MOTION.keyhole.height}%`,
};

const SHEEN_MASK: CSSProperties = {
  maskImage: `url(${CUBE_MOTION.sheen})`,
  WebkitMaskImage: `url(${CUBE_MOTION.sheen})`,
};

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
  const gradient = `rb-lm-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // Open and lock zoom through the keyhole: size the zoom so its round top
  // reaches every corner of the window.
  useLayoutEffect(() => {
    const el = root.current;
    const mark = el?.firstElementChild;
    if ((animation !== "open" && animation !== "lock") || !el || !mark) return;
    const box = mark.getBoundingClientRect();
    const cx = box.left + (box.width * K.cx) / 100;
    const cy = box.top + (box.height * K.cy) / 100;
    const far = Math.hypot(Math.max(cx, window.innerWidth - cx), Math.max(cy, window.innerHeight - cy));
    const radius = (box.width * K.r) / 100;
    el.style.setProperty("--rb-lm-zoom", String(Math.ceil((far * 1.08) / radius)));
  }, [animation, size]);

  const quiet = !wordmark || !tagline;
  function onAnimationEnd(e: AnimationEvent<HTMLDivElement>) {
    switch (e.animationName) {
      case "rb-lm-zoom-in":
        onCovered?.();
        break;
      case "rb-lm-fade-out":
        onCovered?.();
        onDone?.();
        break;
      case "rb-lm-sweep":
        if (quiet && animation !== "loading") onDone?.();
        break;
      case "rb-lm-tag-in":
      case "rb-lm-open-out":
      case "rb-lm-fade-in":
        onDone?.();
        break;
    }
  }

  const srcSizes = `${size}px`;
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
      <div className="rb-lm-mark" aria-hidden="true" style={MARK_VARS}>
        <i className="rb-lm-shadow" />
        <div className="rb-lm-zoom">
          <div className="rb-lm-cube">
            <img
              className="rb-lm-body"
              src={CUBE_MOTION.body.src}
              srcSet={CUBE_MOTION.body.srcSet}
              sizes={srcSizes}
              alt=""
              decoding="sync"
              draggable={false}
            />
            {/* Width descriptors are the body's, so both layers pick the same resolution. */}
            <img
              className="rb-lm-light"
              src={CUBE_MOTION.light.src}
              srcSet={CUBE_MOTION.light.srcSet}
              sizes={srcSizes}
              style={LIGHT_BOX}
              alt=""
              decoding="sync"
              draggable={false}
            />
            <i className="rb-lm-bloom" />
            <div className="rb-lm-sheen" style={SHEEN_MASK}>
              <i />
            </div>
          </div>
          <svg className="rb-lm-door" viewBox="0 0 100 100">
            <defs>
              <radialGradient id={gradient} gradientUnits="userSpaceOnUse" cx={K.cx} cy={K.cy} r={K.r * 3.4}>
                <stop offset="0" style={{ stopColor: "var(--rb-lm-door-0)" }} />
                <stop offset="0.3" style={{ stopColor: "var(--rb-lm-door-1)" }} />
                <stop offset="1" style={{ stopColor: "var(--rb-lm-door-2)" }} />
              </radialGradient>
            </defs>
            <path d={CUBE_MOTION.door} fill={`url(#${gradient})`} />
          </svg>
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

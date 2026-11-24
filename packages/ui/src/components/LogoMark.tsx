import { CUBE_STILL } from "../brand/cube-still";

export interface LogoMarkProps {
  size?: number;
  /**
   * Draw the flat mark (vector) instead of the 3D render. Defaults to on below
   * 28 px, where the render turns to mush; the taskbar asks for it explicitly.
   */
  compact?: boolean;
  /** Accessible name; omit when the logo sits next to the "Rulebox" text. */
  label?: string;
  className?: string;
}

/**
 * The still logo (PRD 25.5): the teal cube with the amber keyhole. Both forms
 * are files made by `pnpm gen:brand`: the render as small WebPs picked from a
 * srcset for the size and screen density, and below 28 px the flat vector
 * traced from it (brand/geometry.ts). As images they cost no JavaScript.
 */
export function LogoMark({ size = 32, compact = size < 28, label, className }: LogoMarkProps) {
  return (
    <img
      className={["rb-logo", className ?? ""].filter(Boolean).join(" ")}
      src={compact ? CUBE_STILL.flat : CUBE_STILL.src}
      srcSet={compact ? undefined : CUBE_STILL.srcSet}
      sizes={compact ? undefined : `${size}px`}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      decoding="async"
      draggable={false}
    />
  );
}

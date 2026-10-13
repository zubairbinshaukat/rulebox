import type { CSSProperties } from "react";

export interface BackdropProps {
  /**
   * Shifts the blob layer vertically (px) so two windows can share one
   * continuous backdrop (e.g. taskbar aligned with the desktop).
   */
  offsetY?: number;
}

/** The two blurred colour blobs behind the desktop. Hidden in Lite mode via CSS. */
export function Backdrop({ offsetY = 0 }: BackdropProps) {
  const style: CSSProperties | undefined =
    offsetY !== 0 ? { transform: `translateY(${offsetY}px)` } : undefined;

  return (
    <div className="rb-backdrop" aria-hidden="true" style={style}>
      <div className="rb-backdrop__blob rb-backdrop__blob--a" />
      <div className="rb-backdrop__blob rb-backdrop__blob--b" />
    </div>
  );
}

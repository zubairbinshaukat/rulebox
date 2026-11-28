import type { CSSProperties } from "react";

/** The look of a `Truncate` box (one to three lines, an optional width cap): shared by the real component and its placeholder. */
export function truncateBoxProps(lines: 1 | 2 | 3, maxWidth: number | string | undefined, className: string | undefined) {
  const style: CSSProperties | undefined = maxWidth === undefined ? undefined : { maxWidth };
  return {
    className: ["dash-truncate-box", lines > 1 ? "dash-truncate-box--lines" : "", className ?? ""].filter(Boolean).join(" "),
    style: lines > 1 ? ({ ...style, "--dash-lines": lines } as CSSProperties) : style,
    "data-lines": lines,
  };
}
import { lazy, Suspense } from "react";
import { truncateBoxProps } from "./truncateBox";
import type { TruncateProps } from "./Truncate";

// `Truncate` (the cut-text measuring and tooltip) is a separate download: the first list page paints with
// the plain, CSS-only box below (the ellipsis works without any script) and the real component takes over.
const Real = lazy(() => import("./Truncate").then((m) => ({ default: m.Truncate })));

/** `Truncate` for the table path: same markup at once, the tooltip and tab stop a moment later. */
export function TruncateLazy({ full, lines = 1, maxWidth, className, children }: TruncateProps) {
  return (
    <Suspense fallback={<span {...truncateBoxProps(lines, maxWidth, className)}>{children}</span>}>
      <Real full={full} lines={lines} maxWidth={maxWidth} className={className}>
        {children}
      </Real>
    </Suspense>
  );
}
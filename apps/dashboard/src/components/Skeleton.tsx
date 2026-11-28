import type { CSSProperties } from "react";
import { strings } from "../lib/strings";

/** A grey block. Shimmers only when motion is allowed (CSS handles reduced motion and Lite). */
export function Skeleton({ width = "100%", height = 12, radius, style }: { width?: number | string; height?: number; radius?: number; style?: CSSProperties }) {
  return <span className="dash-sk" aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />;
}

const WIDTHS = ["38%", "22%", "16%", "12%"];

/** Placeholder rows for a table or list, the same height as real rows (no layout jump). */
export function SkeletonRows({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="dash-sk-rows" role="status" aria-label={strings.app.loading}>
      {Array.from({ length: rows }, (_, r) => (
        <div className="dash-sk-row" key={r}>
          <Skeleton width={30} height={30} radius={9} />
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} width={WIDTHS[c % WIDTHS.length]} height={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div role="status" aria-label={strings.app.loading} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "55%" : "100%"} height={i === 0 ? 18 : 12} />
      ))}
    </div>
  );
}

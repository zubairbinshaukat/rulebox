import type { CSSProperties, ReactNode } from "react";
import { Spinner } from "@rulebox/ui";

/** A centred line (or two) in a viewer: loading, an error, "Preview not available". */
export function ViewerMessage({
  title,
  detail,
  children,
  busy = false,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div role={busy ? "status" : "alert"} style={box}>
      {busy ? <Spinner /> : null}
      <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{title}</p>
      {detail ? <p style={{ margin: 0, fontSize: 13.5, color: "var(--rb-muted)" }}>{detail}</p> : null}
      {children}
    </div>
  );
}

export function ViewerLoading({ label = "Loading…" }: { label?: string }) {
  return <ViewerMessage busy title={label} />;
}

/** A thin banner above a viewer, e.g. "Showing the first part of this file." */
export function ViewerBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: "6px 16px",
        fontSize: 12.5,
        background: "var(--rb-warning-soft, var(--rb-accent-soft))",
        color: "var(--rb-ink)",
        borderBottom: "1px solid var(--rb-line)",
      }}
    >
      {children}
    </div>
  );
}

const box: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 32,
  textAlign: "center",
  color: "var(--rb-ink)",
};

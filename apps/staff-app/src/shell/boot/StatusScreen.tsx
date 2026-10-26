import { LogoMark, LogoMotion } from "@rulebox/ui";

import { useDocumentTitle } from "../../lib/a11y";

export type StatusKind =
  | "waiting"
  | "unavailable"
  | "needsUpdate"
  | "notSetUp"
  | "removed"
  | "applying";

const COPY: Record<StatusKind, { title: string; detail?: string; loading: boolean }> = {
  waiting: { title: "Starting Rulebox…", loading: true },
  unavailable: {
    title: "Rulebox is still starting. If this does not change, contact your administrator.",
    loading: true,
  },
  needsUpdate: {
    title: "Rulebox needs an update. Please contact your administrator.",
    loading: false,
  },
  notSetUp: { title: "This PC is not set up yet.", loading: false },
  removed: {
    title: "This PC has been removed from your organization. Contact your administrator.",
    loading: false,
  },
  applying: { title: "Getting this PC ready…", loading: true },
};

export function StatusScreen({ kind }: { kind: StatusKind }) {
  const copy = COPY[kind];
  useDocumentTitle("Rulebox");
  return (
    <main
      data-testid={`status-${kind}`}
      aria-busy={copy.loading}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        padding: 40,
        background: "var(--rb-bg)",
        color: "var(--rb-ink)",
        textAlign: "center",
      }}
    >
      {copy.loading ? (
        <LogoMotion animation="loading" size={96} wordmark={false} tagline={null} />
      ) : (
        <LogoMark size={72} />
      )}
      {/* A status, not an alert: it says where the PC is and changes by itself. */}
      <p role="status" style={{ margin: 0, maxWidth: 420, fontSize: 16, fontWeight: 500, lineHeight: 1.45 }}>
        {copy.title}
      </p>
      {copy.detail ? (
        <p style={{ margin: 0, maxWidth: 420, color: "var(--rb-muted)", fontSize: 14 }}>
          {copy.detail}
        </p>
      ) : null}
    </main>
  );
}

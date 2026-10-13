import { useShell } from "../lib/store";

/** Minimal link + session readout so DemoAgent progress is visible. */
export function StatusPanel() {
  const link = useShell((s) => s.link);
  const session = useShell((s) => s.session);
  const agent = useShell((s) => s.agent);
  const caps = useShell((s) => s.capabilities);

  const sessionLabel = (() => {
    switch (session.status) {
      case "signedOut":
        return session.last
          ? `signed out (last: ${session.last.name})`
          : "signed out";
      case "signingIn":
        return "signing in…";
      case "signedIn":
        return `signed in: ${session.employee.name}${session.locked ? " (locked)" : ""}${session.offline ? " · offline" : ""}`;
      case "signingOut":
        return "signing out…";
      default: {
        const _exhaustive: never = session;
        return _exhaustive;
      }
    }
  })();

  return (
    <div
      style={{
        padding: 24,
        color: "var(--rb-fg, var(--rb-ink))",
        fontFamily: "var(--rb-font-sans)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 480,
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 600 }}>Rulebox shell</div>
      <div>Link: {link}</div>
      <div>Session: {sessionLabel}</div>
      <div>
        Agent:{" "}
        {agent
          ? `${agent.enrollment} · ${agent.connection} · kiosk ${agent.kioskPhase}${agent.orgName ? ` · ${agent.orgName}` : ""}`
          : "—"}
      </div>
      <div style={{ color: "var(--rb-muted)", fontSize: 12 }}>
        Caps: {caps.length ? caps.join(", ") : "—"}
      </div>
    </div>
  );
}

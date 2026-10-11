import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Avatar, Backdrop, Button, Input, Panel, SegmentedControl, setLite, setTheme, type Theme } from "@rulebox/ui";
import { api } from "@convex/_generated/api";

const themes = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
] as const;

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Static sign-in visual (no real auth until Phase 4). */
export function App() {
  const [theme, setThemeState] = useState<Theme>("light");
  // Lite mode: ?lite=1 for now; the agent will set it in later phases.
  const [lite, setLiteState] = useState(() => new URLSearchParams(location.search).get("lite") === "1");
  const now = useNow();
  const ping = useQuery(api.health.ping);

  useEffect(() => setTheme(theme), [theme]);
  useEffect(() => setLite(lite), [lite]);

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const date = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const backend = ping === undefined ? "Backend: connecting…" : "Backend: connected";

  return (
    <div className="rb-root" style={{ position: "fixed", inset: 0, overflow: "hidden", userSelect: "none" }}>
      <Backdrop />
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 36,
          padding: 24,
        }}
      >
        <div style={{ position: "absolute", top: 32, left: 40, display: "flex", alignItems: "center", gap: 10, fontWeight: 500 }}>
          <span style={{ width: 20, height: 20, border: "2px solid currentColor", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ width: 6, height: 6, background: "currentColor", borderRadius: 2 }} />
          </span>
          <span>Rulebox</span>
        </div>

        <div style={{ position: "absolute", top: 24, right: 32, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <SegmentedControl options={themes} value={theme} onChange={setThemeState} aria-label="Theme" />
          <Button variant="ghost" style={{ height: 34, padding: "0 12px" }} onClick={() => setLiteState((l) => !l)}>
            Lite: {lite ? "on" : "off"}
          </Button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 96, fontWeight: 300, letterSpacing: "-0.045em", lineHeight: 1 }}>{time}</div>
          <div style={{ fontSize: 18, color: "var(--rb-muted)" }}>{date}</div>
        </div>

        <Panel style={{ width: "100%", maxWidth: 360, padding: 28, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <Avatar name="Maya Okafor" />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: 19, fontWeight: 500 }}>Maya Okafor</span>
            <span style={{ fontSize: 13, color: "var(--rb-muted)" }}>Front desk</span>
          </div>
          <div style={{ width: "100%", display: "flex", gap: 8 }}>
            <Input type="password" placeholder="Password" aria-label="Password" />
            <Button icon aria-label="Sign in">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
          </div>
          <div style={{ fontSize: 12, color: "var(--rb-faint)" }}>Preview only: sign-in is not wired yet</div>
        </Panel>

        <div style={{ position: "absolute", left: 40, bottom: 28, fontSize: 12, color: "var(--rb-muted)" }}>{backend}</div>
      </div>
    </div>
  );
}
import { useEffect, useState } from "react";
import { SegmentedControl, setLite, setTheme, type Theme } from "@rulebox/ui";
import { Gallery } from "./Gallery";
import { Status } from "./Status";

type Route = "status" | "gallery";

const routes = [
  { value: "status", label: "Status" },
  { value: "gallery", label: "Gallery" },
] as const;

export function App() {
  const [route, setRoute] = useState<Route>(window.location.hash === "#gallery" ? "gallery" : "status");
  const [theme, setThemeState] = useState<Theme>("light");
  const [lite, setLiteState] = useState(false);

  useEffect(() => setTheme(theme), [theme]);
  useEffect(() => setLite(lite), [lite]);

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "28px 40px" }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em", marginRight: "auto" }}>
          Rulebox Dashboard
        </h1>
        <SegmentedControl options={routes} value={route} onChange={setRoute} aria-label="Page" />
      </header>
      {route === "status" ? (
        <Status />
      ) : (
        <Gallery theme={theme} onTheme={setThemeState} lite={lite} onLite={setLiteState} />
      )}
    </div>
  );
}
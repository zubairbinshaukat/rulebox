import { useEffect, useState } from "react";
import type { Employee, ShellState } from "@rulebox/types";
import { Backdrop } from "@rulebox/ui";

import { call } from "../../lib/tauri";
import { AppGrid } from "./AppGrid";
import { formatDesktopDate, greetingFor } from "./greeting";
import { MyFilesPanel } from "./MyFilesPanel";

const TASKBAR_PAD = 84;

export interface DesktopProps {
  shell: ShellState;
  employee: Employee;
}

export function Desktop({ shell, employee }: DesktopProps) {
  const [now, setNow] = useState(() => new Date());
  const [wide, setWide] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth >= 1000 : true),
  );

  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1000);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const first = employee.name.trim().split(/\s+/)[0] || employee.name;
  const org = shell.agent?.orgName ?? "Rulebox";
  const offline = shell.system.network === "none";

  async function refreshCatalogue() {
    try {
      await call("refresh_catalogue", {});
    } catch {
      // ignore
    }
  }

  return (
    <div
      data-testid="desktop"
      style={{
        position: "absolute",
        inset: 0,
        padding: `28px 36px ${TASKBAR_PAD + 16}px`,
        display: "flex",
        flexDirection: "column",
        gap: 20,
        background: "var(--rb-bg)",
        color: "var(--rb-ink)",
        boxSizing: "border-box",
      }}
    >
      <Backdrop />
      <header style={{ display: "flex", flexDirection: "column", gap: 6, position: "relative", zIndex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13.5,
            color: "var(--rb-muted)",
          }}
        >
          <span>{formatDesktopDate(now)}</span>
          <span aria-hidden>·</span>
          <span>{org}</span>
          {offline ? (
            <span
              style={{
                marginLeft: 4,
                padding: "2px 8px",
                borderRadius: 999,
                background: "var(--rb-warning-soft)",
                color: "var(--rb-warning-text)",
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              Offline
            </span>
          ) : null}
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 32,
            fontWeight: 500,
            letterSpacing: "-0.025em",
          }}
        >
          {greetingFor(now, first)}
        </h1>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 24, position: "relative", zIndex: 1 }}>
        <AppGrid
          apps={shell.apps.items}
          tasks={shell.tasks}
          status={shell.apps.status}
          onRetry={() => void refreshCatalogue()}
        />
        {wide ? (
          <MyFilesPanel onOpenFiles={() => void call("launch_app", { id: "files" })} />
        ) : null}
      </div>
    </div>
  );
}

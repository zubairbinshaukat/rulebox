import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Avatar } from "@rulebox/ui";
import type { AppEntry } from "@rulebox/types";
import IconLogout from "~icons/solar/logout-2-bold-duotone";
import IconMagnifier from "~icons/solar/magnifer-bold-duotone";
import IconMoon from "~icons/solar/moon-bold-duotone";
import IconPower from "~icons/solar/power-bold-duotone";
import IconRestart from "~icons/solar/restart-bold-duotone";

import { useShell } from "../../lib/store";
import { call } from "../../lib/tauri";
import { AppIcon } from "../appIcon";
import { matchesSearch } from "./search";

/**
 * Start: search, the employee's apps, profile, log out and power.
 * Recent files join the search in Step 13.
 */
export function StartMenu() {
  const apps = useShell((s) => s.apps.items);
  const session = useShell((s) => s.session);
  const canPowerOff = useShell((s) => s.system.canPowerOff);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const employee = session.status === "signedIn" ? session.employee : null;
  const results = useMemo(
    () => apps.filter((app) => matchesSearch(app.name, query)),
    [apps, query],
  );
  const clamped = results.length === 0 ? 0 : Math.min(active, results.length - 1);

  async function openApp(app: AppEntry) {
    await call("launch_app", { id: app.id });
    await call("popup_close", {});
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setActive((index) => Math.min(results.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter" && results[clamped]) {
      event.preventDefault();
      void openApp(results[clamped]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      void call("popup_close", {});
    }
  }

  return (
    <div
      data-testid="start-menu"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: 16,
        gap: 14,
        minHeight: 0,
      }}
    >
      <label style={{ position: "relative", display: "block" }}>
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 12,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            color: "var(--rb-muted)",
            pointerEvents: "none",
          }}
        >
          <IconMagnifier width={18} height={18} />
        </span>
        <input
          className="rb-input"
          aria-label="Search apps"
          placeholder="Search apps"
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onSearchKey}
          style={{ width: "100%", paddingLeft: 38 }}
        />
      </label>

      <div
        role="listbox"
        aria-label="Apps"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          alignContent: "start",
        }}
      >
        {results.length === 0 ? (
          <p style={{ gridColumn: "1 / -1", margin: 0, color: "var(--rb-muted)", fontSize: 14 }}>
            No results
          </p>
        ) : null}
        {results.map((app, index) => (
          <button
            key={app.id}
            type="button"
            role="option"
            aria-selected={index === clamped}
            onMouseEnter={() => setActive(index)}
            onClick={() => void openApp(app)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              textAlign: "left",
              padding: "10px 12px",
              borderRadius: 12,
              border: 0,
              background: index === clamped ? "var(--rb-accent-soft)" : "transparent",
              color: "var(--rb-ink)",
              cursor: "pointer",
              font: "inherit",
              fontSize: 14.5,
            }}
          >
            <span style={{ fontSize: 22, display: "flex", color: "var(--rb-accent)" }}>
              <AppIcon app={app} />
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {app.name}
            </span>
          </button>
        ))}
      </div>

      <p style={{ margin: 0, fontSize: 12.5, color: "var(--rb-muted)" }}>No recent files yet</p>

      {employee ? (
        <button
          type="button"
          onClick={() => void call("popup_open", { kind: "account", anchor: null })}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 4px",
            border: 0,
            borderTop: "1px solid var(--rb-line)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
          }}
        >
          <Avatar name={employee.name} size={36} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 500 }}>{employee.name}</span>
            {employee.role ? (
              <span style={{ display: "block", fontSize: 12.5, color: "var(--rb-muted)" }}>
                {employee.role}
              </span>
            ) : null}
          </span>
        </button>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={() => void call("popup_open", { kind: "confirm", anchor: null })}
          style={footerButton}
        >
          <IconLogout width={18} height={18} />
          Log out
        </button>
        {canPowerOff ? (
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <IconAction label="Sleep" onClick={() => void call("power_sleep", {})}>
              <IconMoon width={18} height={18} />
            </IconAction>
            <IconAction label="Restart" onClick={() => void call("power_restart", {})}>
              <IconRestart width={18} height={18} />
            </IconAction>
            <IconAction label="Shut down" onClick={() => void call("power_shut_down", {})}>
              <IconPower width={18} height={18} />
            </IconAction>
          </span>
        ) : null}
      </div>
    </div>
  );
}

const footerButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  borderRadius: 12,
  border: 0,
  background: "transparent",
  color: "var(--rb-ink)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 14,
};

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        border: 0,
        background: "transparent",
        color: "var(--rb-ink)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Avatar, FileChip } from "@rulebox/ui";
import type { AppEntry, Entry } from "@rulebox/types";
import IconDocument from "~icons/solar/document-bold-duotone";
import IconLogout from "~icons/solar/logout-2-bold-duotone";
import IconMagnifier from "~icons/solar/magnifer-bold-duotone";
import IconMoon from "~icons/solar/moon-bold-duotone";
import IconPower from "~icons/solar/power-bold-duotone";
import IconRestart from "~icons/solar/restart-bold-duotone";

import { openFile } from "../../lib/files";
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
  const canSleep = useShell((s) => s.system.canSleep);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Restart and Shut down close every app, so they need a second click.
  const [armed, setArmed] = useState<"restart" | "shutdown" | null>(null);
  const listId = useId();
  const optionId = (appId: string) => `${listId}-${appId}`;
  // While the armed button has the keyboard focus the question stays open (no 4 s timer to race);
  // moving the focus away, or Escape, cancels it.
  const armedFocused = useRef(false);

  useEffect(() => {
    if (armed === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (!armedFocused.current) {
        setArmed(null);
      }
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  function powerAction(kind: "restart" | "shutdown") {
    if (armed !== kind) {
      setArmed(kind);
      return;
    }
    setArmed(null);
    void call(kind === "restart" ? "power_restart" : "power_shut_down", {}).catch(() => {
      // The shell posts a notice when Windows refuses.
    });
  }

  const employee = session.status === "signedIn" ? session.employee : null;
  const results = useMemo(
    () => apps.filter((app) => matchesSearch(app.name, query)),
    [apps, query],
  );
  const clamped = results.length === 0 ? 0 : Math.min(active, results.length - 1);
  const [recentFiles, setRecentFiles] = useState<Entry[]>([]);

  useEffect(() => {
    void call("fs_recent", {})
      .then((res) => setRecentFiles(res))
      .catch(() => {});
  }, []);

  async function openApp(app: AppEntry) {
    await call("launch_app", { id: app.id });
    await call("popup_close", {});
  }

  async function openRecent(file: Entry) {
    try {
      await openFile(file.path);
    } finally {
      await call("popup_close", {});
    }
  }

  // The active result stays in view when the arrows move it down a long list.
  const activeId = results[clamped] ? optionId(results[clamped].id) : undefined;
  useEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeId]);

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    // The results are two columns: Up and Down move a row, Left and Right a cell. Left and
    // Right only do that while the search is empty; otherwise they move the text cursor.
    const sideways = query === "";
    if (event.key === "ArrowDown" || (sideways && event.key === "ArrowRight")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 2 : 1;
      setActive((index) => Math.min(results.length - 1, index + step));
      return;
    }
    if (event.key === "ArrowUp" || (sideways && event.key === "ArrowLeft")) {
      event.preventDefault();
      const step = event.key === "ArrowUp" ? 2 : 1;
      setActive((index) => Math.max(0, index - step));
      return;
    }
    if (event.key === "Home" && sideways) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End" && sideways) {
      event.preventDefault();
      setActive(Math.max(0, results.length - 1));
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
          role="combobox"
          aria-label="Search apps"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
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

      {/* The number of results, said once the search settles (not drawn). */}
      <div role="status" className="rb-sr-only">
        {query ? `${results.length} ${results.length === 1 ? "app" : "apps"} found` : ""}
      </div>

      <div
        id={listId}
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
            id={optionId(app.id)}
            type="button"
            role="option"
            // The focus stays in the search box; the arrows move the highlight (aria-activedescendant).
            tabIndex={-1}
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
              // A line as well as the tint, so the highlighted result is not told by colour alone.
              outline: index === clamped ? "2px solid var(--rb-focus)" : "none",
              outlineOffset: -2,
              color: "var(--rb-ink)",
              cursor: "pointer",
              font: "inherit",
              fontSize: 14.5,
            }}
          >
            <span aria-hidden style={{ fontSize: 22, display: "flex", color: "var(--rb-accent)" }}>
              <AppIcon app={app} />
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {app.name}
            </span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--rb-muted)" }}>Recent files</h2>
        {recentFiles.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--rb-muted)" }}>No recent files yet</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recentFiles.slice(0, 3).map((file) => {
              const dot = file.name.lastIndexOf(".");
              const ext = dot > 0 ? file.name.slice(dot + 1) : "";
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => void openRecent(file)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 6px",
                    borderRadius: 8,
                    border: 0,
                    background: "transparent",
                    color: "var(--rb-ink)",
                    cursor: "pointer",
                    textAlign: "left",
                    font: "inherit",
                    fontSize: 13,
                  }}
                >
                  {ext ? (
                    <FileChip ext={ext} aria-hidden />
                  ) : (
                    <IconDocument width={16} height={16} style={{ color: "var(--rb-muted)" }} />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {file.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

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
          <Avatar name={employee.name} size={36} decorative />
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
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
            {/* Said and drawn: the second click is asked for in words, not only by a red tint. */}
            <span
              role="status"
              style={{ marginRight: 4, fontSize: 12.5, fontWeight: 500, color: "var(--rb-danger-text)" }}
            >
              {armed === "restart" ? "Click again to restart" : armed === "shutdown" ? "Click again to shut down" : ""}
            </span>
            {canSleep ? (
              <IconAction
                label="Sleep"
                onClick={() =>
                  void call("power_sleep", {}).catch(() => {
                    // The shell posts a notice when Windows refuses.
                  })
                }
              >
                <IconMoon width={18} height={18} />
              </IconAction>
            ) : null}
            <IconAction
              label={armed === "restart" ? "Click again to restart" : "Restart"}
              armed={armed === "restart"}
              onClick={() => powerAction("restart")}
              onFocusChange={(focused) => {
                armedFocused.current = focused;
                if (!focused) setArmed((now) => (now === "restart" ? null : now));
              }}
            >
              <IconRestart width={18} height={18} />
            </IconAction>
            <IconAction
              label={armed === "shutdown" ? "Click again to shut down" : "Shut down"}
              armed={armed === "shutdown"}
              onClick={() => powerAction("shutdown")}
              onFocusChange={(focused) => {
                armedFocused.current = focused;
                if (!focused) setArmed((now) => (now === "shutdown" ? null : now));
              }}
            >
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
  armed = false,
  onClick,
  onFocusChange,
  children,
}: {
  label: string;
  /** Waiting for the confirming second click. */
  armed?: boolean;
  onClick: () => void;
  /** The button gained or lost the keyboard focus. */
  onFocusChange?: (focused: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      style={{
        width: 36,
        height: 36,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        border: 0,
        background: armed ? "var(--rb-danger-soft)" : "transparent",
        color: armed ? "var(--rb-danger-text)" : "var(--rb-ink)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

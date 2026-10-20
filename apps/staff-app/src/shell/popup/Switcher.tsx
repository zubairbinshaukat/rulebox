import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskItem } from "@rulebox/types";

import { useTauriEvent } from "../../lib/events";
import { useShell } from "../../lib/store";
import { call, isTauri } from "../../lib/tauri";
import { WindowIcon } from "../taskbar/TaskButton";
import { initialIndex, moveIndex, switcherKey, switcherOrder } from "./switcherLogic";

/**
 * The app switcher (Alt+Tab). The popup holds the focus, so the keys are
 * handled here: Tab / Shift+Tab / arrows move, releasing Alt or Enter picks
 * the window, Escape cancels. A second Alt+Tab (a global hotkey, which never
 * reaches the page) arrives as `popup://cycle`.
 */
export function Switcher() {
  const tasks = useShell((state) => state.tasks);
  const ordered = useMemo(() => switcherOrder(tasks), [tasks]);
  // Until a key or the pointer moves the highlight it is on the window used before this one.
  const [moved, setMoved] = useState<number | null>(null);
  const index = moved ?? initialIndex(ordered.length);
  const chosen = useRef(false);
  const latest = useRef({ ordered, index });

  useEffect(() => {
    latest.current = { ordered, index };
  }, [ordered, index]);

  function activate(task: TaskItem | undefined) {
    if (chosen.current) {
      return;
    }
    chosen.current = true;
    if (isTauri()) {
      if (task) {
        void call("task_click", { id: task.id });
      }
      void call("popup_close", {});
    }
  }

  useTauriEvent<number>("popup://cycle", () => {
    setMoved(moveIndex(latest.current.index, latest.current.ordered.length, 1));
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent, phase: "down" | "up") {
      const action = switcherKey({ key: event.key, shiftKey: event.shiftKey, phase });
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action.type === "move") {
        setMoved(moveIndex(latest.current.index, latest.current.ordered.length, action.delta));
      } else if (action.type === "activate") {
        activate(latest.current.ordered[latest.current.index]);
      } else if (isTauri()) {
        chosen.current = true;
        void call("popup_close", {});
      }
    }
    const down = (event: KeyboardEvent) => onKey(event, "down");
    const up = (event: KeyboardEvent) => onKey(event, "up");
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);

  if (ordered.length === 0) {
    return (
      <div style={{ padding: 24, color: "var(--rb-muted)", fontSize: 14 }}>
        No windows are open.
      </div>
    );
  }

  const selected = Math.min(index, ordered.length - 1);
  return (
    <div
      role="listbox"
      aria-label="Open windows"
      aria-activedescendant={`switch-${ordered[selected]?.id}`}
      style={{
        height: "100%",
        boxSizing: "border-box",
        padding: 16,
        display: "flex",
        gap: 10,
        alignItems: "stretch",
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      {ordered.map((task, position) => (
        <button
          key={task.id}
          id={`switch-${task.id}`}
          type="button"
          role="option"
          aria-selected={position === selected}
          onClick={() => activate(task)}
          onMouseEnter={() => setMoved(position)}
          style={{
            flex: "0 0 132px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: 12,
            borderRadius: 16,
            border: `2px solid ${position === selected ? "var(--rb-accent)" : "transparent"}`,
            background: position === selected ? "var(--rb-accent-soft)" : "transparent",
            color: "var(--rb-ink)",
            font: "inherit",
            cursor: "pointer",
          }}
        >
          <span style={{ width: 48, height: 48, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <WindowIcon iconKey={task.iconKey} enabled={isTauri()} />
          </span>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              textAlign: "center",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              lineHeight: 1.3,
            }}
          >
            {task.title || "Untitled window"}
          </span>
        </button>
      ))}
    </div>
  );
}

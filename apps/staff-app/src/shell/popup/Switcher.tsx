import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskItem } from "@rulebox/types";

import { useTauriEvent } from "../../lib/events";
import { useShell } from "../../lib/store";
import { call, isTauri } from "../../lib/tauri";
import { AppArt } from "../AppArtIcon";
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
  const apps = useShell((state) => state.apps.items);
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

  // The listbox holds the keyboard focus, so a screen reader follows the highlight (aria-activedescendant).
  const listRef = useRef<HTMLDivElement>(null);
  const hasWindows = ordered.length > 0;
  useEffect(() => {
    listRef.current?.focus();
  }, [hasWindows]);

  if (ordered.length === 0) {
    return (
      <div className="rb-switcher rb-switcher--empty" role="status">
        <span className="rb-switcher__eyebrow">Switch apps</span>
        <span className="rb-switcher__title">No windows are open</span>
      </div>
    );
  }

  const selected = Math.min(index, ordered.length - 1);
  const current = ordered[selected];
  const appOf = (task: TaskItem) => (task.appId ? apps.find((app) => app.id === task.appId) : undefined);
  const currentApp = current ? appOf(current) : undefined;
  return (
    <div className="rb-switcher">
      <div className="rb-switcher__head">
        <span className="rb-switcher__eyebrow">Switch apps · {ordered.length}</span>
        <span className="rb-switcher__title">{currentApp?.name ?? current?.title ?? "Untitled window"}</span>
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Open windows"
        aria-activedescendant={`switch-${current?.id}`}
        tabIndex={-1}
        className="rb-switcher__list rb-focus-inset"
      >
        {ordered.map((task, position) => {
          const app = appOf(task);
          const title = task.title || "Untitled window";
          return (
            <button
              key={task.id}
              id={`switch-${task.id}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={position === selected}
              className="rb-switcher__item"
              title={title}
              onClick={() => activate(task)}
              onMouseEnter={() => setMoved(position)}
            >
              {app ? (
                <AppArt app={app} large />
              ) : (
                <span className="rb-task__art rb-task__art--image rb-task__art--lg">
                  <WindowIcon iconKey={task.iconKey} enabled={isTauri()} />
                </span>
              )}
              <span className="rb-switcher__label">{app?.name ?? title}</span>
              {app && title !== app.name ? <span className="rb-switcher__sub">{title}</span> : null}
              {task.minimized ? <span className="rb-switcher__state">Minimized</span> : null}
            </button>
          );
        })}
      </div>
      <div className="rb-switcher__hints" aria-hidden>
        <span>
          <kbd className="rb-kbd">Tab</kbd> next
        </span>
        <span>
          <kbd className="rb-kbd">Shift</kbd>+<kbd className="rb-kbd">Tab</kbd> back
        </span>
        <span>release <kbd className="rb-kbd">Alt</kbd> to switch</span>
        <span>
          <kbd className="rb-kbd">Esc</kbd> cancel
        </span>
      </div>
    </div>
  );
}
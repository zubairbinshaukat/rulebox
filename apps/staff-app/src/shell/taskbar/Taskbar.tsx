import { useRef } from "react";
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { useGSAP } from "@gsap/react";
import { LogoMark, Surface } from "@rulebox/ui";
import type { AppEntry, TaskItem } from "@rulebox/types";

import { useMotionLevel } from "../../lib/motion";
import { useShell } from "../../lib/store";
import { anchorOf, call, isTauri } from "../../lib/tauri";
import { AppIcon } from "../appIcon";
import { clickTarget, groupTaskbar, labelOf, stateOf } from "./grouping";
import { TaskButton, WindowIcon } from "./TaskButton";

gsap.registerPlugin(Flip, useGSAP);

/**
 * The strip: Start, then pinned apps and every open window. A click restores,
 * minimizes or focuses; right click (or Shift+F10) opens the task menu. The
 * system area (network, volume, battery, clock, account) is Step 10.
 */
export function Taskbar() {
  const level = useMotionLevel();
  const start = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);
  // The buttons' positions after the previous change: the FLIP starting point.
  const flipState = useRef<Flip.FlipState | null>(null);

  const signedIn = useShell((s) => s.session.status === "signedIn" && !s.session.locked);
  const apps = useShell((s) => s.apps.items);
  const tasks = useShell((s) => s.tasks);
  const inTauri = isTauri();

  const buttons = signedIn ? groupTaskbar(apps, tasks) : [];
  const signature = buttons.map((b) => b.key).join("|");

  useGSAP(
    () => {
      const el = row.current;
      if (!el) {
        flipState.current = null;
        return;
      }
      const targets = el.querySelectorAll("[data-flip-id]");
      // Read the natural layout: stop a running reorder and drop its transforms.
      gsap.killTweensOf(targets);
      gsap.set(targets, { clearProps: "transform" });
      const natural = Flip.getState(targets);
      const previous = flipState.current;
      flipState.current = natural;
      if (level !== "full" || !previous) {
        return;
      }
      Flip.from(previous, {
        targets,
        duration: 0.25,
        ease: "power2.out",
        onEnter: (entering) =>
          gsap.fromTo(
            entering,
            { autoAlpha: 0, scale: 0.85 },
            { autoAlpha: 1, scale: 1, duration: 0.2, ease: "power2.out" },
          ),
      });
    },
    { dependencies: [signature, level], scope: row },
  );

  const openStart = () => {
    if (!inTauri || !start.current) {
      return;
    }
    void call("popup_open", {
      kind: "start",
      anchor: anchorOf(start.current),
    });
  };

  /** A click: the app's window when it has one, else start the app. */
  const clickPinned = (app: AppEntry, windows: TaskItem[]) => {
    if (!inTauri) {
      return;
    }
    const target = clickTarget(windows);
    if (target) {
      void call("task_click", { id: target.id });
    } else {
      void call("launch_app", { id: app.id });
    }
  };

  const menuFor = (taskId: string | null, appId: string | null) => {
    if (inTauri) {
      void call("task_menu", { id: taskId, appId });
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        boxSizing: "border-box",
        padding: "var(--rb-taskbar-inset)",
        fontFamily: "var(--rb-font-sans)",
        color: "var(--rb-ink)",
      }}
    >
      <Surface
        kind="bar"
        style={{
          height: "var(--rb-taskbar)",
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          gap: 4,
          minWidth: 0,
        }}
      >
        {signedIn ? (
          <>
            <button
              ref={start}
              type="button"
              className="rb-task"
              aria-label="Start"
              title="Start"
              onClick={openStart}
            >
              <span className="rb-task__icon">
                <LogoMark size={28} compact />
              </span>
            </button>
            <span className="rb-task-divider" aria-hidden />
            <div
              ref={row}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 4,
                overflowX: "auto",
                overflowY: "hidden",
                scrollbarWidth: "none",
              }}
            >
              {buttons.length === 0 ? (
                <span style={{ padding: "0 8px", color: "var(--rb-muted)", fontSize: 13.5 }}>
                  Open an app to get started
                </span>
              ) : null}
              {buttons.map((button) =>
                button.kind === "pinned" ? (
                  <TaskButton
                    key={button.key}
                    flipId={button.key}
                    label={labelOf(button.app.name, button.tasks)}
                    state={stateOf(button.tasks)}
                    icon={<AppIcon app={button.app} />}
                    onClick={() => clickPinned(button.app, button.tasks)}
                    onContextMenu={() => {
                      const target = clickTarget(button.tasks);
                      menuFor(target?.id ?? null, target ? null : button.app.id);
                    }}
                  />
                ) : (
                  <TaskButton
                    key={button.key}
                    flipId={button.key}
                    label={labelOf(button.task.title || "Untitled window", [button.task])}
                    state={stateOf([button.task])}
                    icon={<WindowIcon iconKey={button.task.iconKey} enabled={inTauri} />}
                    onClick={() => {
                      if (inTauri) {
                        void call("task_click", { id: button.task.id });
                      }
                    }}
                    onContextMenu={() => menuFor(button.task.id, null)}
                  />
                ),
              )}
            </div>
          </>
        ) : null}
      </Surface>
    </div>
  );
}

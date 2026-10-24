import { useRef, type CSSProperties } from "react";
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { useGSAP } from "@gsap/react";
import { Avatar, LogoMark } from "@rulebox/ui";
import type { AppEntry, TaskItem } from "@rulebox/types";
import IconBell from "~icons/solar/bell-bold-duotone";

import { useMotionLevel } from "../../lib/motion";
import { useShell } from "../../lib/store";
import { anchorOf, call, isTauri } from "../../lib/tauri";
import { hueFor } from "../appArt";
import { AppIcon } from "../appIcon";
import { clickTarget, groupTaskbar, labelOf, stateOf } from "./grouping";
import { TaskButton, WindowIcon } from "./TaskButton";
import { Clock } from "./Clock";
import { SystemArea } from "./SystemArea";

gsap.registerPlugin(Flip, useGSAP);

/**
 * The strip: Start, then pinned apps and every open window. A click restores,
 * minimizes or focuses; right click (or Shift+F10) opens the task menu. The
 * The account button opens the account menu. The bell, network, volume,
 * battery and clock open quick settings or show the time.
 */
export function Taskbar() {
  const level = useMotionLevel();
  const start = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);
  // The buttons' positions after the previous change: the FLIP starting point.
  const flipState = useRef<Flip.FlipState | null>(null);

  const signedIn = useShell((s) => s.session.status === "signedIn" && !s.session.locked);
  const unread = useShell((s) => s.notices.filter((notice) => notice.unread).length);
  const employeeName = useShell((s) =>
    s.session.status === "signedIn" ? s.session.employee.name : null,
  );
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

  const openQuick = (element: Element) => {
    if (!inTauri) {
      return;
    }
    void call("popup_open", {
      kind: "quickSettings",
      anchor: anchorOf(element),
    });
  };

  const openAccount = (element: Element) => {
    if (!inTauri) {
      return;
    }
    void call("popup_open", {
      kind: "account",
      anchor: anchorOf(element),
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

  // The live preview above a button (Standard mode); Lite shows only the tooltip.
  const lite = useShell((state) => state.display.lite);
  const previewing = useRef(false);
  const showPreview = (task: TaskItem | null | undefined, element: HTMLElement) => {
    if (!inTauri || lite || !task) {
      return;
    }
    void call("thumb_open", { taskId: task.id, anchor: anchorOf(element) }).then(
      (shown) => {
        previewing.current = shown;
      },
      () => undefined,
    );
  };
  const hidePreview = () => {
    if (previewing.current) {
      previewing.current = false;
      void call("popup_close", {});
    }
  };

  const menuFor = (taskId: string | null, appId: string | null) => {
    if (inTauri) {
      void call("task_menu", { id: taskId, appId });
    }
  };

  const closePopup = () => {
    if (inTauri) {
      void call("popup_close", {});
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
      <div className="rb-taskbar" onPointerDown={closePopup}>
        {signedIn ? (
          <div className="rb-dock rb-dock--start">
            <button
              ref={start}
              type="button"
              className="rb-task"
              aria-label="Start"
              title="Start"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={openStart}
            >
              <span className="rb-task__icon">
                <LogoMark size={30} compact />
              </span>
            </button>
          </div>
        ) : (
          <div />
        )}
        {signedIn ? (
          <div ref={row} className="rb-dock rb-dock--apps">
              {buttons.length === 0 ? (
                <span style={{ padding: "0 10px", color: "var(--rb-muted)", fontSize: 13.5 }}>
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
                    icon={<AppArt app={button.app} />}
                    onClick={() => clickPinned(button.app, button.tasks)}
                    onHover={(element) => showPreview(clickTarget(button.tasks), element)}
                    onHoverEnd={hidePreview}
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
                    icon={
                      <span className="rb-task__art rb-task__art--image">
                        <WindowIcon iconKey={button.task.iconKey} enabled={inTauri} />
                      </span>
                    }
                    onClick={() => {
                      if (inTauri) {
                        void call("task_click", { id: button.task.id });
                      }
                    }}
                    onContextMenu={() => menuFor(button.task.id, null)}
                    onHover={(element) => showPreview(button.task, element)}
                    onHoverEnd={hidePreview}
                  />
                ),
              )}
          </div>
        ) : (
          <div />
        )}
        <div className="rb-dock rb-dock--tray">
          {signedIn && employeeName ? (
            <button
              type="button"
              className="rb-chip rb-chip--icon"
              aria-label={unread > 0 ? `Notices, ${unread} new` : "Notices"}
              title="Notices"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => openQuick(event.currentTarget)}
            >
              <IconBell width={20} height={20} />
              {unread > 0 ? <span className="rb-chip__dot" aria-hidden /> : null}
            </button>
          ) : null}
          <SystemArea />
          <Clock />
          {signedIn && employeeName ? (
            <button
              type="button"
              className="rb-tray-button"
              aria-label="Account"
              title={employeeName}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => openAccount(event.currentTarget)}
            >
              <Avatar name={employeeName} size={40} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A catalogue app's art on its taskbar button: its own icon, or its Solar glyph in colour. */
function AppArt({ app }: { app: AppEntry }) {
  const style = { ["--rb-hue" as string]: hueFor(app) } as CSSProperties;
  if (app.iconUrl) {
    return (
      <span className="rb-task__art rb-task__art--image" style={style}>
        <img src={app.iconUrl} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className="rb-task__art rb-task__art--glyph" style={style}>
      <AppIcon app={app} />
    </span>
  );
}

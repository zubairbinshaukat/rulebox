import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { TitleBar } from "@rulebox/ui";
import IconClose from "~icons/solar/close-square-bold-duotone";
import IconCopy from "~icons/solar/copy-bold-duotone";
import IconDocument from "~icons/solar/document-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconGallery from "~icons/solar/gallery-bold-duotone";
import IconMaximize from "~icons/solar/maximize-square-bold-duotone";
import IconMinimize from "~icons/solar/minimize-square-bold-duotone";
import IconVideo from "~icons/solar/videocamera-bold-duotone";
import IconWidget from "~icons/solar/widget-4-bold-duotone";

import { useMotionLevel } from "../lib/motion";
import { call, isTauri } from "../lib/tauri";
import { FileExplorer } from "./files/FileExplorer";

gsap.registerPlugin(useGSAP);

interface AppTab {
  title: string;
  kind: string;
  path: string;
}

interface AppView {
  label: string;
  lite: boolean;
  maximized: boolean;
  selected: number;
  tabs: AppTab[];
}

const ZONES: { id: SnapZone; label: string }[] = [
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "topLeft", label: "Top left" },
  { id: "topRight", label: "Top right" },
  { id: "bottomLeft", label: "Bottom left" },
  { id: "bottomRight", label: "Bottom right" },
];

type SnapZone =
  | "left"
  | "right"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight"
  | "maximize"
  | "restore";

function arrowZone(key: string): SnapZone | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "maximize";
    case "ArrowDown":
      return "restore";
    default:
      return null;
  }
}

/** One built-in window: a title bar, and in Lite mode a row of tabs. */
export function AppHost() {
  const level = useMotionLevel();
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<AppView | null>(null);
  const [focused, setFocused] = useState(true);
  const [snapOpen, setSnapOpen] = useState(false);
  const closing = useRef(false);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let unlistenState: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    let gone = false;
    void call("app_snapshot", {})
      .then((next) => {
        if (!gone) {
          setView(next);
        }
      })
      .catch(() => {
        // The window may already be closing.
      });
    void listen<AppView>("app://state", (event) => {
      setView(event.payload);
    }).then((unlisten) => {
      if (gone) {
        unlisten();
      } else {
        unlistenState = unlisten;
      }
    });
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((unlisten) => {
        if (gone) {
          unlisten();
        } else {
          unlistenFocus = unlisten;
        }
      })
      .catch(() => {
        // Focus events are optional; the title stays in the focused style.
      });
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) {
        return;
      }
      const zone = arrowZone(event.key);
      if (!zone) {
        return;
      }
      event.preventDefault();
      void call("win_snap", { zone });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      gone = true;
      unlistenState?.();
      unlistenFocus?.();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) {
        return;
      }
      if (level === "fade") {
        gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, ease: "power2.out" });
      } else {
        gsap.fromTo(
          el,
          { autoAlpha: 0, scale: 0.97 },
          { autoAlpha: 1, scale: 1, duration: 0.2, ease: "power2.out" },
        );
      }
      return () => {
        gsap.killTweensOf(el);
      };
    },
    { scope: root, dependencies: [level] },
  );

  const selected = view?.tabs[view.selected];
  const title = selected?.title ?? "Files";

  async function closeWindow() {
    if (closing.current) {
      return;
    }
    closing.current = true;
    const el = root.current;
    if (el) {
      await new Promise<void>((resolve) => {
        if (level === "fade") {
          gsap.to(el, { autoAlpha: 0, duration: 0.2, ease: "power2.out", onComplete: resolve });
        } else {
          gsap.to(el, {
            autoAlpha: 0,
            scale: 0.97,
            duration: 0.2,
            ease: "power2.out",
            onComplete: resolve,
          });
        }
      });
    }
    await call("win_close", {});
  }

  return (
    <div
      ref={root}
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--rb-bg)",
        color: "var(--rb-ink)",
        overflow: "hidden",
      }}
    >
      <TitleBar
        title={title}
        icon={kindIcon(selected?.kind)}
        focused={focused}
        dragRegion
        maximized={view?.maximized ?? false}
        onDoubleClick={() => void call("win_toggle_maximize", {})}
        onMinimize={() => void call("win_minimize", {})}
        onMaximize={() => void call("win_toggle_maximize", {})}
        onClose={() => void closeWindow()}
        minimizeIcon={<IconMinimize width={16} height={16} />}
        maximizeIcon={<IconMaximize width={16} height={16} />}
        restoreIcon={<IconCopy width={16} height={16} />}
        closeIcon={<IconClose width={16} height={16} />}
      >
        <div style={{ position: "relative" }}>
          <button
            type="button"
            aria-label="Snap layouts"
            aria-expanded={snapOpen}
            title="Snap"
            onClick={() => setSnapOpen((open) => !open)}
            style={snapButton}
          >
            <IconWidget width={16} height={16} />
          </button>
          {snapOpen ? (
            <div role="menu" aria-label="Snap layouts" style={snapMenu}>
              {ZONES.map((zone) => (
                <button
                  key={zone.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSnapOpen(false);
                    void call("win_snap", { zone: zone.id });
                  }}
                  style={snapItem}
                >
                  {zone.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </TitleBar>
      {view?.lite ? (
        <div role="tablist" aria-label="Open documents" style={tabRow}>
          {view.tabs.map((tab, index) => {
            const on = index === view.selected;
            return (
              <div key={`${tab.kind}:${tab.path}:${index}`} style={{ display: "flex" }}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => void call("app_select_tab", { index })}
                  style={{
                    ...tabButton,
                    background: on ? "var(--rb-surface)" : "transparent",
                    color: on ? "var(--rb-ink)" : "var(--rb-muted)",
                  }}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => void call("app_close_tab", { index })}
                  style={tabClose}
                >
                  <IconClose width={14} height={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {!selected || selected.kind === "files" ? (
          <FileExplorer key={selected?.path ?? ""} initialPath={selected?.path ?? ""} />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 32,
            }}
          >
            <div style={{ textAlign: "center", maxWidth: 360 }}>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{heading(selected)}</div>
              <p style={{ margin: "8px 0 0", color: "var(--rb-muted)", fontSize: 14 }}>
                {selected?.path ? selected.path : "Nothing here yet."}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function heading(tab: AppTab | undefined): string {
  if (!tab || tab.kind === "files") {
    return "Files on this laptop";
  }
  return tab.title;
}

function kindIcon(kind: string | undefined): ReactNode {
  switch (kind) {
    case "image":
      return <IconGallery width={14} height={14} />;
    case "media":
      return <IconVideo width={14} height={14} />;
    case "files":
    case undefined:
      return <IconFolder width={14} height={14} />;
    case "pdf":
    case "text":
    case "sheet":
      return <IconDocument width={14} height={14} />;
    default:
      return <IconDocument width={14} height={14} />;
  }
}

const snapButton: CSSProperties = {
  width: 32,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: 0,
  borderRadius: 8,
  background: "transparent",
  color: "var(--rb-ink)",
  cursor: "pointer",
};

const snapMenu: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: 6,
  minWidth: 160,
  padding: 6,
  borderRadius: 12,
  background: "var(--rb-surface)",
  border: "1px solid var(--rb-line)",
  boxShadow: "var(--rb-shadow-md)",
  zIndex: 5,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const snapItem: CSSProperties = {
  textAlign: "left",
  border: 0,
  background: "transparent",
  color: "var(--rb-ink)",
  borderRadius: 8,
  padding: "8px 10px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13.5,
};

const tabRow: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "6px 10px 0",
  overflow: "auto",
  flex: "none",
};

const tabButton: CSSProperties = {
  border: 0,
  borderRadius: "10px 0 0 10px",
  padding: "6px 8px 6px 12px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};

const tabClose: CSSProperties = {
  border: 0,
  borderRadius: "0 10px 10px 0",
  background: "transparent",
  color: "var(--rb-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  padding: "0 8px 0 2px",
};

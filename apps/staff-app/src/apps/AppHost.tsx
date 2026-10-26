import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { MenuItem, MenuList, rovingKeyDown, TitleBar } from "@rulebox/ui";
import IconClose from "~icons/solar/close-square-bold-duotone";
import IconCloseTab from "~icons/solar/close-circle-bold-duotone";
import IconCopy from "~icons/solar/copy-bold-duotone";
import IconDocument from "~icons/solar/document-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconGallery from "~icons/solar/gallery-bold-duotone";
import IconMaximize from "~icons/solar/maximize-square-bold-duotone";
import IconMinimize from "~icons/solar/minimize-square-bold-duotone";
import IconVideo from "~icons/solar/videocamera-bold-duotone";
import IconWidget from "~icons/solar/widget-4-bold-duotone";

import { useDocumentTitle } from "../lib/a11y";
import { useMotionLevel } from "../lib/motion";
import { call, isTauri } from "../lib/tauri";
import { FileExplorer } from "./files/FileExplorer";
import { ViewerHost } from "./viewers/ViewerHost";

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
  useDocumentTitle(`${title} - Rulebox`);

  // The snap menu: the first item takes the focus when it opens; Escape or a click elsewhere
  // closes it, and Escape puts the focus back on the button that opened it.
  const snapRoot = useRef<HTMLDivElement>(null);
  const snapButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!snapOpen) {
      return;
    }
    snapRoot.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (snapRoot.current && !snapRoot.current.contains(event.target as Node)) {
        setSnapOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [snapOpen]);

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
        <div
          ref={snapRoot}
          style={{ position: "relative" }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && snapOpen) {
              event.preventDefault();
              event.stopPropagation();
              setSnapOpen(false);
              snapButtonRef.current?.focus();
            }
          }}
        >
          <button
            ref={snapButtonRef}
            type="button"
            aria-label="Snap layouts"
            aria-haspopup="menu"
            aria-expanded={snapOpen}
            title="Snap"
            onClick={() => setSnapOpen((open) => !open)}
            style={snapButton}
          >
            <IconWidget width={16} height={16} />
          </button>
          {snapOpen ? (
            <MenuList aria-label="Snap layouts" style={snapMenu}>
              {ZONES.map((zone) => (
                <MenuItem
                  key={zone.id}
                  onSelect={() => {
                    setSnapOpen(false);
                    snapButtonRef.current?.focus();
                    void call("win_snap", { zone: zone.id });
                  }}
                >
                  {zone.label}
                </MenuItem>
              ))}
            </MenuList>
          ) : null}
        </div>
      </TitleBar>
      {view?.lite ? (
        <div
          role="tablist"
          aria-label="Open documents"
          className="rb-tabstrip"
          // Left/Right/Home/End move to a tab and open it; Delete closes the one in focus.
          onKeyDown={(event) => {
            if (event.key === "Delete") {
              const at = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')?.dataset.index;
              if (at !== undefined) {
                event.preventDefault();
                void call("app_close_tab", { index: Number(at) });
              }
              return;
            }
            const next = rovingKeyDown(event, '[role="tab"]', "horizontal");
            if (next?.dataset.index !== undefined) {
              void call("app_select_tab", { index: Number(next.dataset.index) });
            }
          }}
        >
          {view.tabs.map((tab, index) => {
            const on = index === view.selected;
            return (
              <div
                key={`${tab.kind}:${tab.path}:${index}`}
                role="presentation"
                className="rb-tabstrip__tab"
                data-active={on}
                title={tab.title}
              >
                <button
                  type="button"
                  role="tab"
                  data-index={index}
                  aria-selected={on}
                  aria-keyshortcuts="Delete"
                  tabIndex={on ? 0 : -1}
                  className="rb-tabstrip__select"
                  onClick={() => void call("app_select_tab", { index })}
                >
                  <span className="rb-tabstrip__icon" aria-hidden>
                    {kindIcon(tab.kind)}
                  </span>
                  <span className="rb-tabstrip__title">{tab.title}</span>
                </button>
                {/* A tab list may only hold tabs: for the keyboard this is the Delete key on the tab. */}
                <button
                  type="button"
                  className="rb-tabstrip__close"
                  aria-hidden="true"
                  tabIndex={-1}
                  title={`Close ${tab.title}`}
                  onClick={() => void call("app_close_tab", { index })}
                >
                  <IconCloseTab width={14} height={14} />
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
          <ViewerHost path={selected.path} />
        )}      </main>
    </div>
  );
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
    case "csv":
    case "docx":
    case "xlsx":
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



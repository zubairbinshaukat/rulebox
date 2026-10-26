import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Surface } from "@rulebox/ui";

import { focusInside, trapTab, useDocumentTitle } from "../../lib/a11y";
import { call, isTauri, type PopupKind } from "../../lib/tauri";
import { AccountMenu } from "./AccountMenu";
import { ConfirmLogout } from "./ConfirmLogout";
import { Monitor } from "./Monitor";
import { QuickSettings } from "./QuickSettings";
import { StartMenu } from "./StartMenu";
import { Switcher } from "./Switcher";
import { ThumbPreview } from "./ThumbPreview";

/**
 * The shared popup. Escape, blur and a click on the desktop or taskbar close
 * it. The taskbar's right-click menu is a native menu and does not come through
 * here.
 */
export function PopupRoot() {
  const [kind, setKind] = useState<PopupKind | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const show = await listen<{ kind: PopupKind }>("popup://show", (event) => {
        setKind(event.payload.kind);
      });
      const hide = await listen("popup://hide", () => setKind(null));
      if (disposed) {
        show();
        hide();
      } else {
        unlisten.push(show, hide);
      }
    })();
    return () => {
      disposed = true;
      for (const fn of unlisten) {
        fn();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void call("popup_close", {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const root = useRef<HTMLDivElement>(null);
  const semantics = kind ? POPUP_SEMANTICS[kind] : null;
  useDocumentTitle(semantics?.label ? `${semantics.label} - Rulebox` : "Rulebox");

  // A popup that opens takes the keyboard focus (the switcher and the preview manage it themselves).
  useEffect(() => {
    const element = root.current;
    if (!kind || !element || !POPUP_SEMANTICS[kind].takesFocus) {
      return;
    }
    const frame = window.requestAnimationFrame(() => focusInside(element));
    return () => window.cancelAnimationFrame(frame);
  }, [kind]);

  return (
    <Surface
      kind="popover"
      style={{
        height: "100vh",
        fontFamily: "var(--rb-font-sans)",
        color: "var(--rb-ink)",
        overflow: "hidden",
      }}
    >
      {kind ? (
        <div
          ref={root}
          role={semantics?.role}
          aria-modal={semantics?.takesFocus ? true : undefined}
          aria-label={semantics?.label}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (semantics?.takesFocus && root.current) {
              trapTab(event, root.current);
            }
          }}
          style={{ height: "100%", outline: "none" }}
        >
          {renderKind(kind)}
        </div>
      ) : null}
    </Surface>
  );
}

/**
 * How each popup is announced. Popups that hold the focus are dialogs (Tab stays
 * inside, Escape closes); the preview is only a picture of a window.
 */
const POPUP_SEMANTICS: Record<
  PopupKind,
  { role: "dialog" | "alertdialog" | undefined; label: string | undefined; takesFocus: boolean }
> = {
  start: { role: "dialog", label: "Start", takesFocus: true },
  account: { role: "dialog", label: "Account", takesFocus: true },
  confirm: { role: "alertdialog", label: "Log out", takesFocus: true },
  quickSettings: { role: "dialog", label: "Quick settings", takesFocus: true },
  switcher: { role: "dialog", label: "Switch apps", takesFocus: false },
  thumb: { role: undefined, label: undefined, takesFocus: false },
  monitor: { role: "dialog", label: "Resources", takesFocus: true },
};

function renderKind(kind: PopupKind | null): ReactNode {
  switch (kind) {
    case null:
      return null;
    case "start":
      return <StartMenu />;
    case "account":
      return <AccountMenu />;
    case "confirm":
      return <ConfirmLogout />;
    case "quickSettings":
      return <QuickSettings />;
    case "switcher":
      return <Switcher />;
    case "thumb":
      return <ThumbPreview />;
    case "monitor":
      return <Monitor />;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

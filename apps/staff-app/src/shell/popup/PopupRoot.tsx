import { useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Surface } from "@rulebox/ui";

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
      {renderKind(kind)}
    </Surface>
  );
}

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

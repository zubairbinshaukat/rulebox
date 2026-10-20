import { useEffect, useRef, useState } from "react";

import { call, type ThumbInfo } from "../../lib/tauri";
import { WindowIcon } from "../taskbar/TaskButton";
import { toPhysical } from "./thumbRect";

/**
 * The preview above a task button (Standard mode). The page only leaves an
 * empty box; DWM draws the live picture of the window there. A minimized
 * window, or one DWM cannot show, gets its icon and title instead.
 */
export function ThumbPreview() {
  const [info, setInfo] = useState<ThumbInfo | null>(null);
  // `null` until the backend has answered; then whether a live picture is shown.
  const [attached, setAttached] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    void call("thumb_state", {}).then(
      (next) => {
        if (current) setInfo(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const element = box.current;
    if (!info || info.minimized || !element) {
      return;
    }
    let current = true;
    const rect = toPhysical(element.getBoundingClientRect(), window.devicePixelRatio || 1);
    void call("thumb_attach", rect).then(
      (done) => {
        if (current) setAttached(done);
      },
      () => {
        if (current) setAttached(false);
      },
    );
    return () => {
      current = false;
    };
  }, [info]);

  if (!info) {
    return null;
  }
  const showIcon = info.minimized || attached === false;

  return (
    <div style={{ height: "100%", boxSizing: "border-box", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ width: 20, height: 20, display: "inline-flex", flexShrink: 0 }}>
          <WindowIcon iconKey={info.iconKey} enabled />
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {info.title || "Untitled window"}
        </span>
      </div>
      <div
        ref={box}
        style={{
          flex: 1,
          minHeight: 0,
          borderRadius: 10,
          background: showIcon ? "var(--rb-bg)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {showIcon ? (
          <span style={{ width: 48, height: 48, display: "inline-flex" }}>
            <WindowIcon iconKey={info.iconKey} enabled />
          </span>
        ) : null}
      </div>
    </div>
  );
}

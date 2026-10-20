import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import { isTauri } from "./tauri";

/**
 * Listen to a Tauri event for as long as the component lives. The handler may
 * change on every render; the subscription is made once. Nothing happens
 * outside Tauri (browser preview, tests).
 */
export function useTauriEvent<T>(name: string, handler: (payload: T) => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<T>(name, (event) => latest.current(event.payload)).then((stop) => {
      // The component may have gone before the subscription was ready.
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [name]);
}

import { useEffect, type RefObject } from "react";

import { call, isTauri } from "../../lib/tauri";

/** While fullscreen, repeat the request this often (the backend gives up after about 7 s). */
export const COVER_BEAT_MS = 2000;

/**
 * Makes a fullscreen `<video>` cover the whole screen, taskbar included. The
 * taskbar is a separate always-on-top window, so the page asks the backend
 * (`viewer_fullscreen`) to hide it and to let this window cover the monitor.
 *
 * It says so again every couple of seconds while fullscreen, and says "off"
 * when fullscreen ends, when the page is hidden or unloaded and when the player
 * goes away. If the page dies, the repeats stop and the backend restores the
 * taskbar by itself.
 */
export function useFullscreenCover(target: RefObject<Element | null>): void {
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let beat: number | undefined;
    let covering = false;

    function send(on: boolean) {
      void call("viewer_fullscreen", { on }).catch(() => undefined);
    }

    function start() {
      if (covering) {
        return;
      }
      covering = true;
      send(true);
      beat = window.setInterval(() => send(true), COVER_BEAT_MS);
    }

    function stop() {
      if (!covering) {
        return;
      }
      covering = false;
      window.clearInterval(beat);
      beat = undefined;
      send(false);
    }

    function onChange() {
      const element = target.current;
      if (element && document.fullscreenElement === element) {
        start();
      } else {
        stop();
      }
    }

    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [target]);
}

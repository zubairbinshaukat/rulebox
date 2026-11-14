import { useLayoutEffect, useRef, useState } from "react";
import { Backdrop, Button, LogoMark, Panel } from "@rulebox/ui";
import type { BroadcastDto } from "@rulebox/types";
import IconBell from "~icons/solar/bell-bing-bold-duotone";

import { useDocumentTitle } from "../../lib/a11y";
import { enter, useMotionLevel } from "../../lib/motion";
import { call } from "../../lib/tauri";
import "./notice.css";

export interface BroadcastFullscreenProps {
  broadcast: BroadcastDto;
  /** The organization's name (`agent.orgName`); "Rulebox" when it is not known. */
  orgName: string | null;
}

/**
 * The full-screen notice (Phase 5 Step 12, plan 4.17): a broadcast with the "fullscreen" style that
 * nobody has acknowledged. It fills the page (and, in the real shell, a cover window on every
 * monitor) until someone presses "OK" (`broadcast_ack`); the next snapshot marks it acknowledged and
 * the view goes. The title and the text are plain text (text nodes, never HTML). Lite mode and
 * reduced motion get a fade; the shared Backdrop and Panel have no blur in Lite.
 */
export function BroadcastFullscreen({ broadcast, orgName }: BroadcastFullscreenProps) {
  const level = useMotionLevel();
  const card = useRef<HTMLDivElement>(null);
  const motion = useRef(level);
  useLayoutEffect(() => {
    motion.current = level;
  });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useDocumentTitle("Notice - Rulebox");

  // In: once, when the notice appears. The tween is killed when it goes (unmount).
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) {
      return;
    }
    const tween = enter(el, motion.current);
    return () => {
      tween.kill();
    };
  }, []);

  async function acknowledge() {
    if (pending) {
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      await call("broadcast_ack", { id: broadcast.id });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const name = orgName?.trim() ? orgName : "Rulebox";
  return (
    <main data-testid="broadcast-fullscreen" className="rb-cover" aria-labelledby="rb-notice-title">
      <Backdrop />
      <div className="rb-cover__center">
        <div ref={card} className="rb-cover__wrap">
          <Panel className="rb-cover__card">
            <div className="rb-cover__org">
              <LogoMark size={22} />
              <span>{name}</span>
            </div>
            <span className="rb-cover__icon" aria-hidden>
              <IconBell width={34} height={34} />
            </span>
            <h1 id="rb-notice-title" className="rb-cover__title" data-testid="broadcast-title">
              {broadcast.title || "Notice"}
            </h1>
            {broadcast.body ? (
              <p role="status" className="rb-cover__text" data-testid="broadcast-body">
                {broadcast.body}
              </p>
            ) : null}
            {failed ? (
              <p role="alert" className="rb-cover__error">
                Could not send OK. Try again.
              </p>
            ) : null}
            <Button type="button" disabled={pending} onClick={() => void acknowledge()} data-autofocus>
              OK
            </Button>
          </Panel>
        </div>
      </div>
    </main>
  );
}

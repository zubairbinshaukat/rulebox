import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@rulebox/ui";
import type { BroadcastDto } from "@rulebox/types";
import IconBell from "~icons/solar/bell-bing-bold-duotone";
import IconClose from "~icons/solar/close-circle-bold-duotone";

import { enter, useMotionLevel } from "../../lib/motion";
import { call } from "../../lib/tauri";
import { pickBanner } from "./logic";
import "./notice.css";

export interface BroadcastBannerProps {
  broadcasts: readonly BroadcastDto[];
}

/**
 * The broadcast strip at the top of the desktop (Phase 5 Step 12, plan 4.17; owner decision
 * 2026-11-14: top of the desktop, not a taskbar window). It sits in the page's own flow above the
 * greeting, so nothing is covered. One strip at a time (the newest that nobody has answered).
 * A broadcast that needs an acknowledgement has "OK" only (`broadcast_ack`, the agent queues the
 * acknowledgement); any other can be closed, and a closed one stays closed until the page reloads.
 *
 * The title and the text are plain text: they are rendered as text nodes, never as HTML, and the
 * administrator's line breaks are kept by CSS. Lite mode and reduced motion get a fade.
 */
export function BroadcastBanner({ broadcasts }: BroadcastBannerProps) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const item = pickBanner(broadcasts, closed);
  if (!item) {
    return null;
  }
  // Keyed by id: the next broadcast gets its own entrance and a clean error/pending state.
  return (
    <BannerStrip
      key={item.id}
      item={item}
      onClose={() => setClosed((previous) => new Set(previous).add(item.id))}
    />
  );
}

function BannerStrip({ item, onClose }: { item: BroadcastDto; onClose: () => void }) {
  const level = useMotionLevel();
  const box = useRef<HTMLDivElement>(null);
  const motion = useRef(level);
  useLayoutEffect(() => {
    motion.current = level;
  });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // In: once, when the strip appears. The tween is killed when it goes (unmount).
  useLayoutEffect(() => {
    const el = box.current;
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
      await call("broadcast_ack", { id: item.id });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={box} className="rb-announce" data-testid="broadcast-banner">
      <div className="rb-announce__card" role="status">
        <span className="rb-announce__icon" aria-hidden>
          <IconBell width={20} height={20} />
        </span>
        <div className="rb-announce__text">
          {item.title ? (
            <span className="rb-announce__title" data-testid="broadcast-title">
              {item.title}
            </span>
          ) : null}
          {item.body ? (
            <span className="rb-announce__body" data-testid="broadcast-body">
              {item.body}
            </span>
          ) : null}
          {failed ? (
            <p role="alert" className="rb-announce__error">
              Could not send OK. Try again.
            </p>
          ) : null}
        </div>
        <div className="rb-announce__actions">
          {item.ackRequired ? (
            <Button type="button" disabled={pending} onClick={() => void acknowledge()}>
              OK
            </Button>
          ) : (
            <button
              type="button"
              className="rb-announce__close"
              aria-label={`Close ${item.title || "announcement"}`}
              onClick={onClose}
            >
              <IconClose width={20} height={20} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

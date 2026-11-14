import { useLayoutEffect, useRef } from "react";
import { Backdrop, LogoMark, Panel } from "@rulebox/ui";
import type { DeviceLockDto } from "@rulebox/types";
import IconLock from "~icons/solar/lock-keyhole-bold-duotone";

import { useDocumentTitle } from "../../lib/a11y";
import { enter, useMotionLevel } from "../../lib/motion";
import { lockMessage } from "./logic";
import "./notice.css";

export interface DeviceLockProps {
  lock: DeviceLockDto;
  /** The organization's name (`agent.orgName`); the logo stands alone when it is not known. */
  orgName: string | null;
}

/**
 * The lock view (Phase 5 Step 12, plan 4.17 and P13): the whole screen, the organization's name,
 * the administrator's message and a contact. **No sign-in field and no button**: the only ways out
 * are the hidden administrator exit (a global hotkey, which still works) and an unlock from the
 * dashboard. It is drawn on the desktop page and, in the real shell, on a cover window on every monitor,
 * so a second monitor shows the same plain surface instead of staying blank.
 *
 * The message and the contact are plain text (text nodes, never HTML). Lite mode and reduced motion
 * get a fade instead of a rise (`lib/motion.ts`); the shared Backdrop and Panel have no blur in Lite.
 */
export function DeviceLock({ lock, orgName }: DeviceLockProps) {
  const level = useMotionLevel();
  const card = useRef<HTMLDivElement>(null);
  const motion = useRef(level);
  useLayoutEffect(() => {
    motion.current = level;
  });
  useDocumentTitle("Locked - Rulebox");

  // In: once, when the view appears. The tween is killed when it goes (unmount).
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

  const name = orgName?.trim() ? orgName : "Rulebox";
  const contact = lock.contact?.trim() ? lock.contact : null;
  return (
    <main data-testid="device-lock" className="rb-cover" aria-labelledby="rb-lock-title">
      <Backdrop />
      <div className="rb-cover__center">
        <div ref={card} className="rb-cover__wrap">
          <Panel className="rb-cover__card">
            <div className="rb-cover__org">
              <LogoMark size={22} />
              <span data-testid="device-lock-org">{name}</span>
            </div>
            <span className="rb-cover__icon" aria-hidden>
              <IconLock width={34} height={34} />
            </span>
            <h1 id="rb-lock-title" className="rb-cover__title">
              This PC is locked
            </h1>
            <p role="status" className="rb-cover__text" data-testid="device-lock-message">
              {lockMessage(lock.message)}
            </p>
            {contact ? (
              <p className="rb-cover__contact" data-testid="device-lock-contact">
                Contact: <strong>{contact}</strong>
              </p>
            ) : null}
          </Panel>
        </div>
      </div>
    </main>
  );
}

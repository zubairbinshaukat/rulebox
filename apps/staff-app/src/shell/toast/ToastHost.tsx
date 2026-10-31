import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import gsap from "gsap";
import type { NoticeTone } from "@rulebox/types";
import IconCheck from "~icons/solar/check-circle-bold-duotone";
import IconClose from "~icons/solar/close-circle-bold-duotone";
import IconDanger from "~icons/solar/danger-circle-bold-duotone";
import IconInfo from "~icons/solar/info-circle-bold-duotone";
import IconWarning from "~icons/solar/danger-triangle-bold-duotone";

import { useMotionLevel, type MotionLevel } from "../../lib/motion";
import { useShell } from "../../lib/store";
import type { ToastEntry } from "./toastQueue";
import { createToastStore } from "./toastStore";
import "./toast.css";

/** How often the countdown is spent while cards are showing. */
const TICK_MS = 250;

const TONE_WORD: Partial<Record<NoticeTone, string>> = {
  success: "Success",
  warning: "Warning",
  danger: "Error",
};

/**
 * Notifications at the bottom right, just above the taskbar, like the ones
 * Windows shows: a small solid card that slides in, stays about six seconds
 * (the countdown pauses while the pointer or the keyboard focus is on a card),
 * and goes when clicked, closed, or pushed out by a fourth.
 *
 * Every notice the shell posts (`AppState::notify`: a download saved or
 * refused, a blocked file, an app that needs an administrator, ...) becomes a
 * card; the bell list keeps them all. The cards live in the taskbar's own
 * window (no extra WebView); that window is taller than the strip and clipped
 * to its pills and these cards, so `onLayout` must be called when the cards
 * change, to send the new clip to Rust (see `useTaskbarShape`).
 *
 * Only transform and opacity animate; Lite mode and reduced motion get a fade.
 */
export function ToastHost({ onLayout }: { onLayout: () => void }) {
  const level = useMotionLevel();
  const signedIn = useShell((s) => s.session.status === "signedIn" && !s.session.locked);
  const notices = useShell((s) => s.notices);

  const [store] = useState(createToastStore);
  const { toasts, held } = useSyncExternalStore(store.subscribe, store.get, store.get);

  // New notices become cards; signing out or locking clears them.
  useEffect(() => {
    store.ingest(notices, signedIn, Date.now());
  }, [store, notices, signedIn]);

  const counting = !held && toasts.some((entry) => !entry.leaving);
  useEffect(() => {
    if (!counting) {
      return;
    }
    let last = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      const spent = now - last;
      last = now;
      store.tick(spent);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [store, counting]);

  // Esc closes the newest card (when this page has the keyboard).
  const hasCards = toasts.some((entry) => !entry.leaving);
  useEffect(() => {
    if (!hasCards) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        store.dismissNewest();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, hasCards]);

  // The cards moved: the clip around them has to follow before the next paint.
  const layout = toasts.map((entry) => entry.id).join(",");
  useLayoutEffect(() => {
    onLayout();
  }, [layout, onLayout]);

  if (toasts.length === 0) {
    return null;
  }
  return (
    <div
      className="rb-toasts"
      role="region"
      aria-label="Notifications"
      onPointerEnter={() => store.hold(true)}
      onPointerLeave={() => store.hold(false)}
      onFocus={() => store.hold(true)}
      onBlur={() => store.hold(false)}
    >
      {toasts.map((entry) => (
        <ToastCard
          key={entry.id}
          entry={entry}
          level={level}
          onDismiss={() => store.dismiss(entry.id)}
          onGone={() => store.remove(entry.id)}
        />
      ))}
    </div>
  );
}

function ToastCard({
  entry,
  level,
  onDismiss,
  onGone,
}: {
  entry: ToastEntry;
  level: MotionLevel;
  onDismiss: () => void;
  onGone: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const { notice } = entry;
  // The latest values, so the animation effects below start once, not on every change.
  const gone = useRef(onGone);
  const motion = useRef(level);
  useLayoutEffect(() => {
    gone.current = onGone;
    motion.current = level;
  });

  // In: slide from the right edge (clipped by the window shape) and fade.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) {
      return;
    }
    const tween =
      motion.current === "full"
        ? gsap.fromTo(el, { x: 56, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.28, ease: "power3.out" })
        : gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.15, ease: "power1.out" });
    return () => {
      tween.kill();
    };
  }, []);

  // Out: the same way back, then the card leaves the list.
  useEffect(() => {
    if (!entry.leaving) {
      return;
    }
    const el = card.current;
    if (!el) {
      gone.current();
      return;
    }
    const done = () => gone.current();
    const tween =
      motion.current === "full"
        ? gsap.to(el, { x: 56, autoAlpha: 0, duration: 0.2, ease: "power2.in", onComplete: done, overwrite: true })
        : gsap.to(el, { autoAlpha: 0, duration: 0.15, ease: "power1.in", onComplete: done, overwrite: true });
    return () => {
      tween.kill();
    };
  }, [entry.leaving]);

  const alert = notice.tone === "warning" || notice.tone === "danger";
  const word = TONE_WORD[notice.tone];
  return (
    <div className="rb-toast" data-tone={notice.tone}>
      <div
        ref={card}
        className="rb-toast__card"
        // A warning or an error is announced at once, the rest politely.
        role={alert ? "alert" : "status"}
        onClick={onDismiss}
      >
        <span className="rb-toast__icon" aria-hidden>
          <ToneIcon tone={notice.tone} />
        </span>
        <span className="rb-toast__text">
          <span className="rb-toast__title" title={notice.title}>
            {word ? <span className="rb-sr-only">{word}: </span> : null}
            {notice.title}
          </span>
          {notice.detail ? <span className="rb-toast__detail">{notice.detail}</span> : null}
        </span>
        <button
          type="button"
          className="rb-toast__close"
          aria-label={`Dismiss ${notice.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
        >
          <IconClose width={18} height={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function ToneIcon({ tone }: { tone: NoticeTone }) {
  switch (tone) {
    case "success":
      return <IconCheck width={22} height={22} />;
    case "warning":
      return <IconWarning width={22} height={22} />;
    case "danger":
      return <IconDanger width={22} height={22} />;
    case "neutral":
    case "accent":
      return <IconInfo width={22} height={22} />;
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

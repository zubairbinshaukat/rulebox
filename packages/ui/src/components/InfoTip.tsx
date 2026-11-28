import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { floatingRoot, useFloating, type FloatingOptions } from "../floating";

export interface InfoTipProps {
  /** The button's accessible name, e.g. "About Kiosk mode". */
  label: string;
  /** The explanation: at most about three short sentences, plain words, no interactive content. */
  children: ReactNode;
  /** Preferred side; it flips when there is no room. Default `"top"`. */
  placement?: "top" | "bottom";
}

const HOVER_DELAY_MS = 300;
const LEAVE_GRACE_MS = 150;

type Source = "hover" | "focus" | "pinned";

/**
 * A small (i) button for the explanation that does not belong in the form itself. Put it right
 * after the label, never inside the `<label>`.
 *
 * Mouse: the tip shows after a short hover and hides when the pointer leaves (a grace period lets the
 * pointer move onto the tip). Keyboard: it shows on focus and hides on blur. Click or tap pins it open;
 * click or tap again, tap outside, blur or Escape closes it. A touch screen has no hover: tapping
 * opens it as a popover.
 *
 * Never put an error or a warning only in here: those stay visible in the page. A tooltip is for
 * "what does this mean", read once.
 */
export function InfoTip({ label, children, placement = "top" }: InfoTipProps) {
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const source = useRef<Source>("hover");
  const timer = useRef(0);
  const viaPointer = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const opts: FloatingOptions = { side: placement, align: "center", gap: 8 };
  useFloating(open, buttonRef, tipRef, opts);

  const clearTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
  }, []);

  const show = useCallback(
    (from: Source) => {
      clearTimer();
      source.current = from;
      setOpen(true);
    },
    [clearTimer],
  );

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const scheduleHide = useCallback(() => {
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(false), LEAVE_GRACE_MS);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  // Outside tap or click, and Escape from anywhere (the tip may be open from a hover).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (buttonRef.current?.contains(t) || tipRef.current?.contains(t))) return;
      hide();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, hide]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Escape" && open) {
      // Closes the tip only, not the dialog around it.
      e.stopPropagation();
      hide();
    }
  }

  const tip = open
    ? createPortal(
        <div
          ref={tipRef}
          id={tipId}
          role="tooltip"
          className="rb-info__tip"
          // The tip cannot take focus; pressing on it must not blur the button either.
          onMouseDown={(e) => e.preventDefault()}
          onPointerEnter={(e) => {
            if (e.pointerType !== "touch") clearTimer();
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "touch" && source.current === "hover") scheduleHide();
          }}
        >
          {children}
        </div>,
        floatingRoot(),
      )
    : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="rb-info"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onPointerDown={() => {
          viaPointer.current = true;
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === "touch" || open) return;
          clearTimer();
          timer.current = window.setTimeout(() => show("hover"), HOVER_DELAY_MS);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "touch") return;
          if (!open) clearTimer();
          else if (source.current === "hover") scheduleHide();
        }}
        onFocus={() => {
          // A click focuses the button too; the click decides then, not the focus.
          if (viaPointer.current) return;
          show("focus");
        }}
        onBlur={() => {
          viaPointer.current = false;
          hide();
        }}
        onClick={() => {
          viaPointer.current = false;
          if (open && source.current === "pinned") hide();
          else show("pinned");
        }}
        onKeyDown={onKeyDown}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          {/* Solar "info-circle-linear". */}
          <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 17V11" />
            <path strokeLinejoin="round" d="M12 8H12.0001" />
          </g>
        </svg>
      </button>
      {tip}
    </>
  );
}

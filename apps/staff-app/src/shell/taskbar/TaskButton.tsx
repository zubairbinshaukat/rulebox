import { useEffect, useRef, useState, type ReactNode } from "react";

import { GenericProgramIcon } from "../appIcon";
import { iconUrl, stateLabel, type ButtonState } from "./grouping";

/** A program window's own icon, served by the `rbicon` protocol. */
export function WindowIcon({ iconKey, enabled }: { iconKey: string; enabled: boolean }) {
  // The key that failed to load: a new key (changed icon) is tried again.
  const [failedKey, setFailedKey] = useState<string | null>(null);

  if (!enabled || failedKey === iconKey) {
    return <GenericProgramIcon />;
  }
  return (
    <img
      src={iconUrl(iconKey)}
      alt=""
      draggable={false}
      onError={() => setFailedKey(iconKey)}
    />
  );
}

export interface TaskButtonProps {
  label: string;
  state: ButtonState;
  icon: ReactNode;
  /** Stable key for the reorder animation. */
  flipId: string;
  onClick?: () => void;
  /** Right click or Shift+F10. */
  onContextMenu?: () => void;
  /** The pointer rested on the button (after HOVER_PREVIEW_MS). Standard mode only. */
  onHover?: (element: HTMLElement) => void;
  /** The pointer left (or the button was pressed). */
  onHoverEnd?: () => void;
}

/** How long the pointer rests on a button before the preview appears. */
export const HOVER_PREVIEW_MS = 400;

/** One taskbar button: icon, open / active indicator, window count, warning. */
export function TaskButton({
  label,
  state,
  icon,
  flipId,
  onClick,
  onContextMenu,
  onHover,
  onHoverEnd,
}: TaskButtonProps) {
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className="rb-task"
      title={label}
      // The window's state in words (the bar under the icon shows it, but not to a screen reader).
      aria-label={stateLabel(label, state)}
      aria-pressed={state.active}
      data-flip-id={flipId}
      data-open={state.open}
      data-active={state.active}
      data-minimized={state.minimized}
      data-flashing={state.flashing}
      onMouseEnter={(event) => {
        if (!onHover) return;
        const element = event.currentTarget;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onHover(element), HOVER_PREVIEW_MS);
      }}
      onMouseLeave={() => {
        window.clearTimeout(timer.current);
        onHoverEnd?.();
      }}
      onClick={() => {
        window.clearTimeout(timer.current);
        onClick?.();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu?.();
      }}
    >
      <span className="rb-task__icon">{icon}</span>
      {state.count > 1 ? (
        <span className="rb-task__count" aria-hidden>
          {state.count}
        </span>
      ) : null}
      {state.hung ? <span className="rb-task__warn" aria-hidden /> : null}
      <span className="rb-task__bar" aria-hidden />
    </button>
  );
}

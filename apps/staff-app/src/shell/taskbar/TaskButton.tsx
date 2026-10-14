import { useState, type ReactNode } from "react";

import { GenericProgramIcon } from "../appIcon";
import { iconUrl, type ButtonState } from "./grouping";

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
}

/** One taskbar button: icon, open / active indicator, window count, warning. */
export function TaskButton({
  label,
  state,
  icon,
  flipId,
  onClick,
  onContextMenu,
}: TaskButtonProps) {
  return (
    <button
      type="button"
      className="rb-task"
      title={label}
      aria-label={label}
      data-flip-id={flipId}
      data-open={state.open}
      data-active={state.active}
      data-minimized={state.minimized}
      data-flashing={state.flashing}
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu?.();
      }}
    >
      <span className="rb-task__icon">{icon}</span>
      {state.count > 1 ? <span className="rb-task__count">{state.count}</span> : null}
      {state.hung ? <span className="rb-task__warn" aria-hidden /> : null}
      <span className="rb-task__bar" aria-hidden />
    </button>
  );
}

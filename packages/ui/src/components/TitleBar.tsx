import type { ReactNode } from "react";

export interface TitleBarProps {
  title: string;
  /** Short text for the 22px icon block. */
  mono?: string;
  /** Replaces the mono block when given. */
  icon?: ReactNode;
  /** When false, the title is muted (unfocused window). Default true. */
  focused?: boolean;
  /** Adds data-tauri-drag-region to the bar and title. */
  dragRegion?: boolean;
  onDoubleClick?: () => void;
  /** Extra controls rendered before the window buttons. */
  children?: ReactNode;
  maximized?: boolean;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
  minimizeIcon?: ReactNode;
  maximizeIcon?: ReactNode;
  restoreIcon?: ReactNode;
  closeIcon?: ReactNode;
}

const defaultMinimize = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const defaultMaximize = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="1" y="1" width="10" height="10" rx="2.5" />
  </svg>
);

const defaultRestore = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3.5" y="0.75" width="7.5" height="7.5" rx="2" opacity="0.55" />
    <rect x="0.75" y="3.75" width="7.5" height="7.5" rx="2" />
  </svg>
);

const defaultClose = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export function TitleBar({
  title,
  mono,
  icon,
  focused = true,
  dragRegion = false,
  onDoubleClick,
  children,
  maximized = false,
  onMinimize,
  onMaximize,
  onClose,
  minimizeIcon,
  maximizeIcon,
  restoreIcon,
  closeIcon,
}: TitleBarProps) {
  const dragProps = dragRegion ? { "data-tauri-drag-region": true } : {};
  const cls = ["rb-titlebar", focused ? "" : "rb-titlebar--unfocused"].filter(Boolean).join(" ");

  return (
    <div className={cls} onDoubleClick={onDoubleClick} {...dragProps}>
      <span className="rb-titlebar__icon">{icon ?? mono ?? title.charAt(0).toUpperCase()}</span>
      <span className="rb-titlebar__title" {...dragProps}>
        {title}
      </span>
      {children ? <div className="rb-titlebar__extra">{children}</div> : null}
      <div className="rb-titlebar__controls">
        <button type="button" title="Minimize" aria-label="Minimize" onClick={onMinimize}>
          {minimizeIcon ?? defaultMinimize}
        </button>
        <button
          type="button"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={onMaximize}
        >
          {maximized ? (restoreIcon ?? defaultRestore) : (maximizeIcon ?? defaultMaximize)}
        </button>
        <button type="button" className="rb-close" title="Close" aria-label="Close" onClick={onClose}>
          {closeIcon ?? defaultClose}
        </button>
      </div>
    </div>
  );
}

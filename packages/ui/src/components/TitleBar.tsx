export interface TitleBarProps {
  title: string;
  /** Short text for the 22px icon block. */
  mono?: string;
  maximized?: boolean;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
}

export function TitleBar({ title, mono, maximized = false, onMinimize, onMaximize, onClose }: TitleBarProps) {
  return (
    <div className="rb-titlebar">
      <span className="rb-titlebar__icon">{mono ?? title.charAt(0).toUpperCase()}</span>
      <span className="rb-titlebar__title">{title}</span>
      <div className="rb-titlebar__controls">
        <button type="button" title="Minimize" aria-label="Minimize" onClick={onMinimize}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={onMaximize}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
            {maximized ? (
              <>
                <rect x="3.5" y="0.75" width="7.5" height="7.5" rx="2" opacity="0.55" />
                <rect x="0.75" y="3.75" width="7.5" height="7.5" rx="2" />
              </>
            ) : (
              <rect x="1" y="1" width="10" height="10" rx="2.5" />
            )}
          </svg>
        </button>
        <button type="button" className="rb-close" title="Close" aria-label="Close" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
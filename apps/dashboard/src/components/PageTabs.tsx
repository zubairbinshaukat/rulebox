import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface PageTab {
  id: string;
  label: string;
  /** A number shown as a small badge after the label (problems, items). Hidden when `undefined`; shown for 0 only when `tone` is not set. */
  count?: number;
  /** Colours the count: `danger` for problems that need action, `warning` for things to look at. */
  tone?: "danger" | "warning";
  icon?: ReactNode;
}

export interface PageTabsProps {
  tabs: readonly PageTab[];
  /** The id of the open tab (see `useUrlTab`). */
  value: string;
  onChange: (id: string) => void;
  "aria-label": string;
  /** Prefix for the element ids: tab `${idBase}-tab-${id}`, panel `${idBase}-panel-${id}`. */
  idBase: string;
  /** The panel: render `PageTabPanel` for the open tab only, so a tab that is not open loads nothing. */
  children?: ReactNode;
}

/** `${idBase}-panel-${id}`: the id `PageTabs` points `aria-controls` at. */
const pageTabPanelId = (idBase: string, id: string) => `${idBase}-panel-${id}`;
const tabId = (idBase: string, id: string) => `${idBase}-tab-${id}`;

/**
 * The tab bar of a page (device detail, settings, ...), WAI-ARIA tabs with automatic activation:
 * the arrow keys, Home and End move focus and open the tab. One tab stop (the open tab); the panel is
 * the next Tab stop. On a phone the bar scrolls sideways and keeps the open tab in view.
 * The caller renders the open panel as `children` (`PageTabPanel`) and nothing for the others.
 */
export function PageTabs({ tabs, value, onChange, "aria-label": label, idBase, children }: PageTabsProps) {
  const bar = useRef<HTMLDivElement>(null);

  // Keep the open tab visible when the bar scrolls (phone, deep link to a tab at the far end).
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!el || typeof el.scrollIntoView !== "function") return;
    const calm =
      document.documentElement.dataset.lite === "true" ||
      (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: calm ? "auto" : "smooth" });
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const rtl = bar.current ? getComputedStyle(bar.current).direction === "rtl" : false;
    const i = Math.max(0, tabs.findIndex((t) => t.id === value));
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = rtl ? i - 1 : i + 1;
        break;
      case "ArrowLeft":
        next = rtl ? i + 1 : i - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length]!;
    onChange(target.id);
    // The open tab is the only one in the tab order; move focus with it.
    bar.current?.querySelector<HTMLElement>(`[id="${tabId(idBase, target.id)}"]`)?.focus();
  };

  return (
    <div className="dash-ptabs">
      <div ref={bar} role="tablist" aria-label={label} className="dash-ptabs__bar" onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={tabId(idBase, t.id)}
              aria-selected={selected}
              aria-controls={pageTabPanelId(idBase, t.id)}
              tabIndex={selected ? 0 : -1}
              className="dash-ptabs__tab"
              onClick={() => onChange(t.id)}
            >
              {t.icon ? (
                <span className="dash-ptabs__icon" aria-hidden="true">
                  {t.icon}
                </span>
              ) : null}
              <span className="dash-ptabs__label">{t.label}</span>
              {t.count !== undefined && (t.count > 0 || !t.tone) ? (
                <span className="dash-ptabs__count" data-tone={t.tone}>
                  {t.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

/** The panel of the open tab. Render it only for the open tab. */
export function PageTabPanel({ idBase, id, children }: { idBase: string; id: string; children?: ReactNode }) {
  return (
    <div role="tabpanel" id={pageTabPanelId(idBase, id)} aria-labelledby={tabId(idBase, id)} tabIndex={0} className="dash-ptabs__panel">
      {children}
    </div>
  );
}

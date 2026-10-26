import { useId, type KeyboardEvent, type ReactNode } from "react";

import { rovingKeyDown } from "../roving";

export interface TabItem {
  id: string;
  label: string;
  closable?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  onClose?: (id: string) => void;
  className?: string;
  children?: ReactNode;
  /** Accessible name of the tab list. */
  "aria-label"?: string;
}

export function Tabs({ tabs, value, onChange, onClose, className, children, "aria-label": ariaLabel }: TabsProps) {
  const uid = useId();
  const cls = ["rb-tabs", className ?? ""].filter(Boolean).join(" ");
  const tabId = (id: string) => `${uid}-tab-${id}`;
  const panelId = `${uid}-panel`;
  const hasSelected = tabs.some((t) => t.id === value);

  // Left/Right/Home/End move the focus and select (automatic activation).
  // Delete closes a closable tab, as in a browser.
  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (tabs.length === 0) return;
    if (e.key === "Delete" && onClose) {
      const focusedId = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]')?.dataset.tabId;
      const tab = tabs.find((t) => t.id === focusedId);
      if (tab?.closable) {
        e.preventDefault();
        onClose(tab.id);
      }
      return;
    }
    const target = rovingKeyDown(e, '[role="tab"]', "horizontal");
    if (target?.dataset.tabId) onChange(target.dataset.tabId);
  }

  return (
    <div className={cls}>
      <div role="tablist" aria-label={ariaLabel} className="rb-tabs__list" onKeyDown={onListKeyDown}>
        {tabs.map((tab, index) => {
          const selected = tab.id === value;
          // With no valid selection the first tab stays reachable by Tab.
          const reachable = selected || (!hasSelected && index === 0);
          return (
            <div
              key={tab.id}
              role="presentation"
              className={["rb-tabs__tab", selected ? "rb-tabs__tab--active" : ""].filter(Boolean).join(" ")}
            >
              <button
                type="button"
                role="tab"
                id={tabId(tab.id)}
                data-tab-id={tab.id}
                aria-selected={selected}
                aria-controls={selected && children ? panelId : undefined}
                aria-keyshortcuts={tab.closable && onClose ? "Delete" : undefined}
                tabIndex={reachable ? 0 : -1}
                className="rb-tabs__btn"
                onClick={() => onChange(tab.id)}
              >
                {tab.label}
              </button>
              {tab.closable && onClose ? (
                // A tab list may only hold tabs, so for keyboard and screen reader users the close
                // button is the Delete key on the tab (aria-keyshortcuts above); the button is for the mouse.
                <button
                  type="button"
                  className="rb-tabs__close"
                  aria-hidden="true"
                  tabIndex={-1}
                  title={`Close ${tab.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {children ? (
        <div role="tabpanel" id={panelId} aria-labelledby={tabId(value)} className="rb-tabs__panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}

import type { KeyboardEvent, ReactNode } from "react";

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
}

export function Tabs({ tabs, value, onChange, onClose, className, children }: TabsProps) {
  const cls = ["rb-tabs", className ?? ""].filter(Boolean).join(" ");
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === value),
  );

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (tabs.length === 0) return;
    let next = activeIndex;
    switch (e.key) {
      case "ArrowRight":
        next = (activeIndex + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (activeIndex - 1 + tabs.length) % tabs.length;
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
    onChange(tabs[next]!.id);
  }

  return (
    <div className={cls}>
      <div role="tablist" className="rb-tabs__list" onKeyDown={onListKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === value;
          return (
            <div key={tab.id} className={["rb-tabs__tab", selected ? "rb-tabs__tab--active" : ""].filter(Boolean).join(" ")}>
              <button
                type="button"
                role="tab"
                id={`rb-tab-${tab.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="rb-tabs__btn"
                onClick={() => onChange(tab.id)}
              >
                {tab.label}
              </button>
              {tab.closable && onClose ? (
                <button
                  type="button"
                  className="rb-tabs__close"
                  aria-label={`Close ${tab.label}`}
                  title={`Close ${tab.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {children ? (
        <div role="tabpanel" aria-labelledby={`rb-tab-${value}`} className="rb-tabs__panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}

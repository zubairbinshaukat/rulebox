import type { KeyboardEvent } from "react";
import { rovingKeyDown } from "@rulebox/ui";
import IconTable from "~icons/solar/list-linear";
import IconCards from "~icons/solar/widget-4-linear";
import { strings } from "../lib/strings";
import { useViewMode, type ViewMode } from "../lib/viewMode";

const OPTIONS: { value: ViewMode; label: string; Icon: typeof IconTable }[] = [
  { value: "table", label: strings.table.viewTable, Icon: IconTable },
  { value: "cards", label: strings.table.viewCards, Icon: IconCards },
];

/**
 * Table | Cards, the one global list view. A segmented radio group like the
 * theme control, but with a Solar icon in each segment (the shared
 * `SegmentedControl` takes text only). The choice lives in `lib/viewMode.ts`.
 * Icon and word; in a narrow list (container under 560 px) the word hides and the `title` names it.
 * `iconOnly` forces the icon alone (the account menu).
 */
export function ViewSwitch({ iconOnly = false }: { iconOnly?: boolean }) {
  const [view, setView] = useViewMode();

  // Arrow keys move the focus and select, as native radio buttons do.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = rovingKeyDown(e, '[role="radio"]', "both");
    const picked = target?.dataset.value as ViewMode | undefined;
    if (picked) setView(picked);
  }

  return (
    <div className="rb-seg dash-viewswitch" role="radiogroup" aria-label={strings.table.view} onKeyDown={onKeyDown}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          data-value={value}
          aria-checked={view === value}
          tabIndex={view === value ? 0 : -1}
          title={label}
          onClick={() => setView(value)}
        >
          <Icon aria-hidden="true" />
          {/* Text stays for screen readers; the list's container hides it under 560 px (dashboard.css). */}
          <span className={iconOnly ? "dash-sr" : "dash-viewswitch__label"}>{label}</span>
        </button>
      ))}
    </div>
  );
}

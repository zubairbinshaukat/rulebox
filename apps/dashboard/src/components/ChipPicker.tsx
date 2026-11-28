import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SearchSelect, type SelectOption } from "@rulebox/ui";
import IconRemove from "~icons/solar/close-circle-linear";
import "./ChipPicker.css";

export interface ChipPickerProps {
  /** Names the group for a screen reader ("Groups"). Not drawn: the form's own label (`Field`) is the visible one. */
  label: string;
  /** Alternative to `label`: the id of the element that names the group. */
  labelledBy?: string;
  /** The chosen values, in the order they were added. */
  value: string[];
  onChange: (value: string[]) => void;
  /** Everything that can be chosen, bounded (the browser filters this list; it is not a table). */
  options: SelectOption[];
  /** At most this many chips; the "Add" box goes away at the limit. */
  max?: number;
  /** Shown while nothing is chosen ("No groups chosen yet"). */
  emptyText: string;
  /** The placeholder of the search box in the "Add" list. */
  searchPlaceholder?: string;
  /** The "Add" button. Default "Add…". */
  addLabel?: string;
  /** Shown in the "Add" list when no option matches. */
  noMatchText?: string;
  /** Shown at the limit, in place of the "Add" box. */
  maxText?: string;
  /** Read-only: chips without the remove buttons, no "Add" box. */
  disabled?: boolean;
  /** How many chips show before "+N more" (default 12). */
  visible?: number;
  /** The accessible name of a remove button. Default `Remove {name}`. */
  removeLabel?: (name: string) => string;
  /** The text announced after a change. Default `{n} selected`. */
  countText?: (n: number) => string;
  /** "+N more" and "Show fewer". */
  moreText?: (n: number) => string;
  fewerText?: string;
  id?: string;
  className?: string;
}

const defaultRemove = (name: string) => `Remove ${name}`;
const defaultCount = (n: number) => `${n} selected`;
const defaultMore = (n: number) => `+${n} more`;

/**
 * Pick several things from a list that can be long (groups, apps): chosen ones are chips with a remove button, and an
 * "Add" box (a `SearchSelect` that no longer offers what is chosen) puts the next one in. Backspace on the empty box
 * takes the last chip off. After more than `visible` chips the rest hide behind "+N more". Every control is a
 * real button: Tab reaches each remove button and the Add box; the number chosen is announced after each change.
 */
export function ChipPicker({
  label,
  labelledBy,
  value,
  onChange,
  options,
  max,
  emptyText,
  searchPlaceholder,
  addLabel = "Add…",
  noMatchText,
  maxText = "That is the most you can add.",
  disabled = false,
  visible = 12,
  removeLabel = defaultRemove,
  countText = defaultCount,
  moreText = defaultMore,
  fewerText = "Show fewer",
  id,
  className,
}: ChipPickerProps) {
  const autoId = useId();
  const addId = `${id ?? autoId}-add`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Where the focus goes after a chip is removed (its button is gone): the chip now in that place, else the Add box.
  const focusAfter = useRef<number | null>(null);

  const names = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options]);
  const left = useMemo(() => options.filter((o) => !value.includes(o.value)), [options, value]);
  const atMax = max !== undefined && value.length >= max;
  const shown = expanded || value.length <= visible ? value : value.slice(0, visible);
  const hidden = value.length - shown.length;
  const canAdd = !disabled && !atMax && left.length > 0;

  useEffect(() => {
    const index = focusAfter.current;
    if (index === null) return;
    focusAfter.current = null;
    const buttons = rootRef.current?.querySelectorAll<HTMLElement>(".dash-pick__x");
    const target = buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : document.getElementById(addId);
    target?.focus({ preventScroll: true });
  }, [value, addId]);

  function remove(at: number) {
    focusAfter.current = at;
    onChange(value.filter((_, i) => i !== at));
  }

  // The search box lives in a popup that is portalled to the page, but React still bubbles its events here.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Backspace" || disabled || value.length === 0) return;
    const el = e.target as HTMLElement;
    const inAdd = el.id === addId || (el instanceof HTMLInputElement && el.value === "" && el.type !== "hidden");
    if (!inAdd) return;
    e.preventDefault();
    onChange(value.slice(0, -1));
  }

  return (
    <div
      ref={rootRef}
      id={id}
      className={["dash-pick", className ?? ""].filter(Boolean).join(" ")}
      role="group"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
    >
      {value.length === 0 ? <p className="dash-pick__empty">{emptyText}</p> : null}
      {shown.length > 0 || canAdd ? (
        <ul className="dash-pick__list">
          {shown.map((v, i) => {
            const name = names.get(v) ?? v;
            return (
              <li key={v} className="dash-pick__chip">
                <span className="dash-pick__name" title={name}>
                  {name}
                </span>
                {disabled ? null : (
                  <button type="button" className="dash-pick__x" aria-label={removeLabel(name)} onClick={() => remove(i)}>
                    <IconRemove aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
          {value.length > visible ? (
            <li className="dash-pick__more">
              <button type="button" className="dash-pick__toggle" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
                {expanded ? fewerText : moreText(hidden)}
              </button>
            </li>
          ) : null}
          {canAdd ? (
            <li className="dash-pick__addwrap">
              <SearchSelect
                id={addId}
                compact
                value=""
                onChange={(v) => onChange([...value, v])}
                options={left}
                placeholder={addLabel}
                searchPlaceholder={searchPlaceholder}
                emptyText={noMatchText}
                aria-label={`${label}: ${addLabel}`}
              />
            </li>
          ) : null}
        </ul>
      ) : null}
      {atMax && !disabled ? <p className="dash-pick__empty">{maxText}</p> : null}
      <span className="dash-sr" role="status" aria-live="polite">
        {countText(value.length)}
      </span>
    </div>
  );
}

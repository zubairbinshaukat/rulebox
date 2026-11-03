import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Input } from "@rulebox/ui";
import IconSearch from "~icons/solar/magnifier-linear";
import IconClose from "~icons/solar/close-circle-linear";
import { useDebounced } from "../lib/useDebounced";
import { strings } from "../lib/strings";

/** The backend accepts search text up to this long (PRD 11.1 list contract). */
export const SEARCH_MAX = 100;

interface CommonProps {
  label: string;
  placeholder?: string;
  /** Longest text the backend accepts; typing and pasting stop there (default 100 with `onSearch`). */
  maxLength?: number;
}

/** The list contract: the search runs on Enter, on the clear button and on Escape (which clears). */
export interface SearchProps extends CommonProps {
  /** The search text the list is showing now (e.g. from the URL). Optional: the box also works uncontrolled. */
  value?: string;
  /** Called with the trimmed text. Enter, the clear button and Escape-to-clear call it; typing does not. */
  onSearch: (text: string) => void;
  /** Old behaviour: also call `onSearch` 250 ms after typing stops. Only for lists that are cheap and not yet migrated. */
  live?: boolean;
  onChange?: undefined;
}

/** The pre-4b contract, kept so screens that debounce themselves keep working until they are migrated. */
export interface LegacySearchProps extends CommonProps {
  value: string;
  onChange: (value: string) => void;
  onSearch?: undefined;
  live?: undefined;
}

/**
 * The search box above a list. A `<form role="search">`: Enter submits, so a
 * list is read from the server once per search, not once per keystroke
 * (Convex free-tier I/O budget). While the typed text is not yet applied, an
 * "Enter" hint shows inside the box.
 */
export function SearchInput(props: SearchProps | LegacySearchProps) {
  return props.onChange ? <LegacySearch {...props} /> : <EnterSearch {...(props as SearchProps)} />;
}

interface BoxProps {
  label: string;
  placeholder?: string;
  maxLength?: number;
  value: string;
  onValue: (value: string) => void;
  onSubmit?: () => void;
  onClear: () => void;
  /** Show the Enter hint (the draft is not applied yet). */
  hint?: boolean;
}

function SearchBox({ label, placeholder, maxLength, value, onValue, onSubmit, onClear, hint }: BoxProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const clear = () => {
    onClear();
    input.current?.focus();
  };
  return (
    <form
      className={["dash-search", onSubmit ? "dash-search--enter" : ""].filter(Boolean).join(" ")}
      role="search"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <label htmlFor={id} className="dash-sr">
        {label}
      </label>
      <IconSearch className="dash-search__icon" aria-hidden="true" />
      <Input
        ref={input}
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-describedby={onSubmit ? hintId : undefined}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            clear();
          }
        }}
      />
      {onSubmit ? (
        <span id={hintId} className="dash-sr">
          {strings.search.hint}
        </span>
      ) : null}
      {onSubmit && hint ? (
        <kbd className="dash-search__hint" aria-hidden="true" title={strings.search.hint}>
          {strings.search.enterKey}
        </kbd>
      ) : null}
      {value ? (
        <button type="button" className="dash-icon-btn dash-search__clear" aria-label={strings.common.clearSearch} title={strings.common.clearSearch} onClick={clear}>
          <IconClose aria-hidden="true" />
        </button>
      ) : null}
    </form>
  );
}

function LegacySearch({ value, onChange, label, placeholder, maxLength }: LegacySearchProps) {
  return <SearchBox label={label} placeholder={placeholder} maxLength={maxLength} value={value} onValue={onChange} onClear={() => onChange("")} />;
}

function EnterSearch({ value, onSearch, live = false, label, placeholder, maxLength = SEARCH_MAX }: SearchProps) {
  const [draft, setDraft] = useState(value ?? "");
  const [applied, setApplied] = useState(value ?? "");
  // The list's own search text changed (back button, a link): show it.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== undefined) {
      setDraft(value);
      setApplied(value);
    }
  }

  // The last text sent to `onSearch`, so `live` never repeats a search that Enter already ran.
  const emitted = useRef(value ?? "");
  const apply = (text: string) => {
    const t = text.trim().slice(0, maxLength);
    setDraft(t);
    setApplied(t);
    emitted.current = t;
    onSearch(t);
  };

  // `live` only: the old debounced behaviour.
  const settled = useDebounced(draft, 250);
  useEffect(() => {
    if (!live) return;
    const t = settled.trim().slice(0, maxLength);
    if (t === emitted.current) return;
    emitted.current = t;
    onSearch(t);
  }, [live, settled, maxLength, onSearch]);

  return (
    <SearchBox
      label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      value={draft}
      onValue={setDraft}
      onSubmit={() => apply(draft)}
      onClear={() => apply("")}
      hint={!live && draft.trim() !== applied}
    />
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { floatingRoot, useFloating, type FloatingOptions } from "../floating";

export interface SelectOption {
  value: string;
  /** Shown in the list and in the trigger; long text truncates in the trigger and wraps (3 lines) in the list. */
  label: string;
  /** A second, smaller line under the label (one short phrase). */
  hint?: string;
  disabled?: boolean;
  /** Decorative glyph before the label (a Solar icon element or an image). */
  icon?: ReactNode;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown in the trigger while `value` matches no option. */
  placeholder?: string;
  /** 40 px high instead of 46 px (filter bars). */
  compact?: boolean;
  disabled?: boolean;
  /** Put on the trigger button, so a `<label htmlFor>` (the dashboard `Field`) names it. */
  id?: string;
  /** Adds a hidden input, so a `<form>` still submits the value. */
  name?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  className?: string;
}

/** Props the searchable variant adds (see `SearchSelect`). */
export interface SelectSearchProps {
  searchPlaceholder?: string;
  /** Shown in the popup when nothing matches. */
  emptyText?: string;
  /**
   * The list comes from the server: called with the text on every change (debounce in the
   * parent); `options` is then shown as given, with no client-side filtering.
   */
  onSearch?: (text: string) => void;
  /** Shows `loadingText` in the popup (a server search is running). */
  loading?: boolean;
  loadingText?: string;
}

export interface SelectBaseProps extends SelectProps, SelectSearchProps {
  searchable?: boolean;
}

const FLOAT: FloatingOptions = { side: "bottom", align: "start", matchWidth: true, gap: 6 };
const PAGE = 8;
const TYPEAHEAD_MS = 700;

/** Lower case without accents, so "cafe" finds "Café". */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function matchesQuery(o: SelectOption, query: string): boolean {
  const q = normalize(query.trim());
  return normalize(o.label).includes(q) || (o.hint ? normalize(o.hint).includes(q) : false);
}

/** First (dir 1) or last (dir -1) enabled index; -1 when every option is disabled. */
function edge(list: SelectOption[], dir: 1 | -1): number {
  if (dir === 1) return list.findIndex((o) => !o.disabled);
  for (let i = list.length - 1; i >= 0; i--) if (!list[i]!.disabled) return i;
  return -1;
}

/** The next enabled index in `dir` (no wrap), or `from` when there is none. */
function nextEnabled(list: SelectOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) if (!list[i]!.disabled) return i;
  return from;
}

/** Type-ahead: one letter (or the same letter repeated) cycles on from `from`; more letters match a prefix. */
function matchAhead(list: SelectOption[], buffer: string, from: number): number {
  const text = normalize(buffer);
  if (!text) return -1;
  const repeated = text.length > 1 && [...text].every((c) => c === text[0]);
  const needle = repeated ? text[0]! : text;
  const startAt = needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < list.length; k++) {
    const i = (startAt + k) % list.length;
    const o = list[i]!;
    if (!o.disabled && normalize(o.label).startsWith(needle)) return i;
  }
  return -1;
}

function isPrintable(e: KeyboardEvent<HTMLElement>): boolean {
  return e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/**
 * The shared implementation of `Select` and `SearchSelect`: a button that opens a listbox
 * popup, portalled to `document.body` and placed by `placeFloating`.
 *
 * Focus moves into the popup while it is open (the listbox, or the search box in the
 * searchable variant) and comes back to the trigger on close; the highlighted option is
 * announced with `aria-activedescendant`. Enter and Space on the trigger open it through the
 * button's own click, so a screen reader's "activate" works the same.
 *
 * Not exported from the package: use `Select` or `SearchSelect`.
 */
export function SelectBase({
  value,
  onChange,
  options,
  placeholder,
  compact = false,
  disabled = false,
  id,
  name,
  className,
  searchable = false,
  searchPlaceholder = "Search",
  emptyText = "No matches",
  loadingText = "Loading…",
  onSearch,
  loading = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  "aria-invalid": ariaInvalid,
  "aria-required": ariaRequired,
}: SelectBaseProps) {
  const autoId = useId();
  const triggerId = id ?? `${autoId}-trigger`;
  const listId = `${autoId}-list`;
  const optionId = (i: number) => `${listId}-${i}`;

  const [open, setOpen] = useState(false);
  // Disabled while open: close during render (React's way to adjust state when a prop changes).
  if (open && disabled) setOpen(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef("");
  const ahead = useRef<{ text: string; timer: number }>({ text: "", timer: 0 });
  const seenSignature = useRef("");

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex]! : undefined;

  const visible = useMemo(
    () => (searchable && !onSearch && query.trim() ? options.filter((o) => matchesQuery(o, query)) : options),
    [options, query, searchable, onSearch],
  );
  const signature = visible.map((o) => o.value).join("\u0001");

  const { update } = useFloating(open, triggerRef, popupRef, FLOAT);

  const close = useCallback(
    (refocus: boolean) => {
      setOpen(false);
      setQuery("");
      if (onSearch && queryRef.current) onSearch("");
      queryRef.current = "";
      ahead.current.text = "";
      if (refocus) triggerRef.current?.focus({ preventScroll: true });
    },
    [onSearch],
  );

  function openMenu(at?: number) {
    if (disabled || open) return;
    setQuery("");
    queryRef.current = "";
    seenSignature.current = options.map((o) => o.value).join("\u0001");
    const start = at ?? (selectedIndex >= 0 && !options[selectedIndex]!.disabled ? selectedIndex : edge(options, 1));
    setActive(start);
    setOpen(true);
  }

  function choose(index: number) {
    const option = visible[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  }

  function typeahead(key: string, list: SelectOption[], from: number): number {
    const a = ahead.current;
    window.clearTimeout(a.timer);
    a.text += key;
    a.timer = window.setTimeout(() => {
      a.text = "";
    }, TYPEAHEAD_MS);
    return matchAhead(list, a.text, from);
  }

  useEffect(() => {
    const a = ahead.current;
    return () => window.clearTimeout(a.timer);
  }, []);

  // Focus goes into the popup on open (the search box, or the listbox itself).
  useLayoutEffect(() => {
    if (!open) return;
    (searchable ? inputRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [open, searchable]);

  // A new result list (typing, or the parent's server search answering): highlight its first option
  // and fit the popup to the new height.
  useLayoutEffect(() => {
    if (!open) return;
    if (searchable && seenSignature.current !== signature) {
      seenSignature.current = signature;
      setActive(edge(visible, 1));
    }
    update();
    // `visible` is read only when `signature` (its content) changed: an inline `options` array must not re-run this every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature, loading, searchable, update]);

  // A click or touch outside closes the popup without taking focus back.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (popupRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  // Keep the highlighted option in view (the list scrolls, the page never does).
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const el = document.getElementById(optionId(active));
    if (!list || !el) return;
    if (active === 0) list.scrollTop = 0;
    else if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu();
    } else if (!searchable && isPrintable(e)) {
      e.preventDefault();
      const i = typeahead(e.key, options, selectedIndex);
      if (i >= 0) openMenu(i);
    }
  }

  function onPopupKeyDown(e: KeyboardEvent<HTMLElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a < 0 ? edge(visible, 1) : nextEnabled(visible, a, 1)));
        return;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) choose(active);
        else setActive((a) => (a < 0 ? edge(visible, -1) : nextEnabled(visible, a, -1)));
        return;
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === "PageDown" ? 1 : -1;
        setActive((a) => {
          let at = a;
          for (let k = 0; k < PAGE; k++) at = nextEnabled(visible, at, dir);
          return at;
        });
        return;
      }
      case "Home":
      case "End":
        // In the search box these move the caret.
        if (searchable) return;
        e.preventDefault();
        e.stopPropagation();
        setActive(edge(visible, e.key === "Home" ? 1 : -1));
        return;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        choose(active);
        return;
      case " ":
        if (searchable) return;
        e.preventDefault();
        e.stopPropagation();
        if (ahead.current.text) {
          const i = typeahead(" ", visible, active);
          if (i >= 0) setActive(i);
        } else choose(active);
        return;
      case "Escape":
        e.preventDefault();
        // The Escape that closes a popup must not also close the dialog around it.
        e.stopPropagation();
        if (searchable && queryRef.current) {
          setQuery("");
          queryRef.current = "";
          onSearch?.("");
        } else close(true);
        return;
      case "Tab":
        // Choose nothing, close, and let Tab carry on from the trigger.
        close(true);
        return;
      default:
        if (!searchable && isPrintable(e)) {
          e.preventDefault();
          e.stopPropagation();
          const i = typeahead(e.key, visible, active);
          if (i >= 0) setActive(i);
        }
    }
  }

  function onSearchChange(e: ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    setQuery(text);
    queryRef.current = text;
    onSearch?.(text);
  }

  const wrapperClass = ["rb-select", "rb-select--dd", compact ? "rb-select--compact" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const activeId = active >= 0 && active < visible.length ? optionId(active) : undefined;
  const showEmpty = visible.length === 0 && !loading;

  const popup = open
    ? createPortal(
        <div
          ref={popupRef}
          className={["rb-dd__popup", compact ? "rb-dd__popup--compact" : ""].filter(Boolean).join(" ")}
          onKeyDown={onPopupKeyDown}
        >
          {searchable ? (
            <div className="rb-dd__search">
              <svg className="rb-dd__search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                {/* Solar "magnifier-linear" (this package cannot use `~icons`). */}
                <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5">
                  <circle cx="11.5" cy="11.5" r="9.5" />
                  <path d="M18.2173 18.2178L21.9999 22.0004" />
                </g>
              </svg>
              <input
                ref={inputRef}
                className="rb-dd__input"
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={activeId}
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                value={query}
                onChange={onSearchChange}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          ) : null}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className="rb-dd__list"
            hidden={searchable && visible.length === 0}
            aria-labelledby={ariaLabelledby ?? triggerId}
            aria-activedescendant={searchable ? undefined : activeId}
          >
            {visible.map((o, i) => {
              const isSelected = o.value === value;
              return (
                <div
                  key={o.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={o.disabled || undefined}
                  data-active={i === active || undefined}
                  className="rb-dd__option"
                  title={o.label.length > 48 ? o.label : undefined}
                  // Keeps the focus where it is (list or search box) while the pointer is down.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    if (!o.disabled && i !== active) setActive(i);
                  }}
                  onClick={() => choose(i)}
                >
                  {o.icon ? (
                    <span className="rb-dd__oicon" aria-hidden="true">
                      {o.icon}
                    </span>
                  ) : null}
                  <span className="rb-dd__otext">
                    <span className="rb-dd__label">{o.label}</span>
                    {o.hint ? <span className="rb-dd__hint">{o.hint}</span> : null}
                  </span>
                  {isSelected ? (
                    <svg className="rb-dd__check" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                      {/* Solar "check-linear". */}
                      <path d="M5 13L9 17L19 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </div>
              );
            })}
          </div>
          {loading ? (
            <div className="rb-dd__status" role="status">
              {loadingText}
            </div>
          ) : showEmpty && searchable ? (
            <div className="rb-dd__status" role="status">
              {emptyText}
            </div>
          ) : null}
        </div>,
        floatingRoot(),
      )
    : null;

  return (
    <span className={wrapperClass} data-open={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        className="rb-select__control rb-dd__trigger"
        disabled={disabled}
        title={selected?.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        aria-invalid={ariaInvalid}
        aria-required={ariaRequired}
        onClick={() => (open ? close(true) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        {selected?.icon ? (
          <span className="rb-dd__oicon" aria-hidden="true">
            {selected.icon}
          </span>
        ) : null}
        <span className={selected ? "rb-dd__value" : "rb-dd__value rb-dd__value--placeholder"}>
          {selected ? selected.label : (placeholder ?? "")}
        </span>
      </button>
      <svg className="rb-select__chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
      {popup}
    </span>
  );
}

/**
 * The dropdown that replaces a native `<select>`: a button that opens a listbox, drawn in the
 * app's own colours in light, dark and Lite, opening down or up by the room there is and never
 * wider than the screen.
 *
 * Keyboard: Arrow Down/Up (or Enter, Space) open it; Arrow keys, Home/End, Page Up/Down and typing
 * letters move; Enter or Space choose; Escape closes with no change; Tab closes with no change.
 * Focus returns to the trigger. Put it in a `Field` and the label names the trigger.
 */
export function Select(props: SelectProps) {
  return <SelectBase {...props} />;
}

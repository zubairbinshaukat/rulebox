import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, Input } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-circle-linear";
import IconDone from "~icons/solar/check-circle-linear";
import IconRemove from "~icons/solar/close-circle-linear";
import { Field, FieldSet } from "../../../components/Field";
import { publicSuffixOf } from "../../../lib/apps/publicSuffixes";
import { normalizeEntry, type EntryProblem } from "../../../lib/apps/siteAccess";
import { appSiteAccessStrings as s } from "../../../lib/screenStrings/appSiteAccess";
import { entryKey, type SiteSuggestion } from "./siteEntries";
import { showHost } from "./webAddress";
import "./web.css";

export interface SiteChipsProps {
  legend: string;
  /** The longer explanation, in an (i) next to the legend. */
  info?: ReactNode;
  /** The whole list. Add and remove hand back a new list of the same kind (`onChange`). */
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Which entries are drawn as chips (default: all). The website picker hides the ones its choices above already write. */
  chips?: readonly string[];
  /** The most entries in `value`. */
  max: number;
  maxText: string;
  noneText?: string;
  suggestions?: readonly SiteSuggestion[];
  suggestLabel?: string;
  addLabel: string;
  addPlaceholder: string;
  addHint?: string;
  /** Names that count as "already in the list" besides `value` (the website's own host). */
  reserved?: readonly string[];
  /** True for an entry the choices above already cover: its chip is muted and says "(already included)". */
  isIncluded?: (entry: string) => boolean;
  disabled?: boolean;
  id?: string;
}

function problemText(reason: EntryProblem | "duplicate", typed: string): string {
  switch (reason) {
    case "suffix": {
      const host = typed.trim().toLowerCase().replace(/^\*\./, "").replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "");
      return s.errors.suffix(publicSuffixOf(host));
    }
    default:
      return s.errors[reason];
  }
}

/**
 * A list of sites as chips with an "Add a site" box (UI pass, add-app plan sections 6 and 13): the "Other sites it needs" of the website
 * picker and the browser rules of a Chrome or Edge program. A typed or pasted address becomes a plain lower-case name (`normalizeEntry`);
 * ports, local names, whole suffixes (`co.uk`) are refused with a sentence. Every control is a real button or input: Tab reaches each
 * remove button, Enter adds (and never submits the form around it), after a removal the focus moves to the next chip or the box.
 */
export function SiteChips({
  legend,
  info,
  value,
  onChange,
  chips,
  max,
  maxText,
  noneText,
  suggestions = [],
  suggestLabel,
  addLabel,
  addPlaceholder,
  addHint,
  reserved = [],
  isIncluded,
  disabled = false,
  id,
}: SiteChipsProps) {
  const auto = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // Where the focus goes after a chip is removed (its button is gone): the chip now in that place, else the box.
  const focusAfter = useRef<number | null>(null);
  const shown = chips ?? value;
  const keys = new Set(value.map(entryKey));
  const atMax = value.length >= max;

  useEffect(() => {
    const index = focusAfter.current;
    if (index === null) return;
    focusAfter.current = null;
    const buttons = rootRef.current?.querySelectorAll<HTMLElement>(".web-chip__x");
    (buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : inputRef.current)?.focus({ preventScroll: true });
  }, [value]);

  function remove(entry: string, at: number) {
    focusAfter.current = at;
    setProblem(null);
    onChange(value.filter((e) => e !== entry));
  }

  function add() {
    if (disabled) return;
    const r = normalizeEntry(text);
    if (!r.ok) {
      setProblem(problemText(r.reason, text));
      return;
    }
    if (keys.has(r.entry) || reserved.includes(r.entry)) {
      setProblem(problemText("duplicate", text));
      return;
    }
    if (atMax) {
      setProblem(maxText);
      return;
    }
    setText("");
    setProblem(null);
    onChange([...value, r.entry]);
  }

  function toggle(group: SiteSuggestion, pressed: boolean) {
    setProblem(null);
    if (pressed) {
      onChange(value.filter((e) => !group.entries.includes(entryKey(e))));
      return;
    }
    const missing = group.entries.filter((e) => !keys.has(e) && !reserved.includes(e));
    if (value.length + missing.length > max) {
      setProblem(maxText);
      return;
    }
    onChange([...value, ...missing]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // The box sits inside the app's form: Enter adds the site and never saves the app.
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
  }

  return (
    <FieldSet legend={legend} info={info}>
      <div ref={rootRef} className="web-chips" id={id ?? auto}>
        {shown.length === 0 && noneText ? <p className="web-chips__none">{noneText}</p> : null}
        {shown.length > 0 ? (
          <ul className="web-chips__list" aria-label={legend}>
            {shown.map((entry, i) => {
              const host = showHost(entryKey(entry));
              const included = isIncluded?.(entry) === true;
              const star = entry.trim().startsWith("*.");
              return (
                <li key={entry} className="web-chip" data-included={included ? "" : undefined}>
                  <span className="web-chip__name" title={host.title ?? host.text}>
                    {host.text}
                  </span>
                  {star ? (
                    <span className="web-chip__note" title={s.wildcardNote}>
                      (*)
                    </span>
                  ) : null}
                  {included ? <span className="web-chip__note">{s.included}</span> : null}
                  {disabled ? null : (
                    <button type="button" className="web-chip__x" aria-label={s.remove(host.text)} onClick={() => remove(entry, i)}>
                      <IconRemove aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {shown.some((e) => e.trim().startsWith("*.")) ? <p className="web-chips__star">{s.wildcardNote}</p> : null}

        {suggestions.length > 0 && !disabled ? (
          <div className="web-suggest" role="group" aria-label={suggestLabel}>
            {suggestions.map((group) => {
              const pressed = group.entries.every((e) => keys.has(e));
              return (
                <button key={group.label} type="button" className="web-suggest__btn" aria-pressed={pressed} onClick={() => toggle(group, pressed)}>
                  {pressed ? <IconDone aria-hidden="true" /> : <IconAdd aria-hidden="true" />}
                  {group.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {disabled ? null : atMax ? (
          <p className="web-chips__max">{maxText}</p>
        ) : (
          <Field label={addLabel} hint={addHint} error={problem}>
            {(p) => (
              <div className="web-add">
                <Input
                  {...p}
                  ref={inputRef}
                  value={text}
                  placeholder={addPlaceholder}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  inputMode="url"
                  onChange={(e) => {
                    setText(e.target.value);
                    if (problem !== null) setProblem(null);
                  }}
                  onKeyDown={onKeyDown}
                />
                <Button type="button" variant="ghost" onClick={add} disabled={text.trim() === ""}>
                  {s.addButton}
                </Button>
              </div>
            )}
          </Field>
        )}
      </div>
    </FieldSet>
  );
}

import { Fragment, useId, useRef, type KeyboardEvent } from "react";
import type { BrowserKind } from "../../../data/types";
import { FieldSet } from "../../../components/Field";
import { alreadyIncluded, levels, MAX_EXTRA_SITES, parseAddress, selectedLevel, withLevel, type ParsedAddress } from "../../../lib/apps/siteAccess";
import { appSiteAccessStrings as s } from "../../../lib/screenStrings/appSiteAccess";
import { SiteChips } from "./SiteChips";
import { DEFAULT_SUGGESTIONS, entryKey, type SiteSuggestion } from "./siteEntries";
import { SitePreview } from "./SitePreview";
import { showHost, withHttps } from "./webAddress";
import "./web.css";


export interface SiteAccessPickerProps {
  /** The form's address. May be empty, invalid or without `https://` (it is added for the example). */
  url: string;
  /** The extra entries (the address's own host excluded, as the form and the server hold them). */
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Edge or Chrome: the preview says that all browser websites on a PC share one list. */
  browser?: BrowserKind;
  suggestions?: readonly SiteSuggestion[];
  /** The refusal to show under the picker (inline, or the server's `allowedDomains` refusal). */
  error?: string;
  /** A viewer, or an archived app: nothing can be changed. */
  disabled?: boolean;
  /** Draw "What employees can open" under the choices (default). The website form puts it in its side column instead. */
  withPreview?: boolean;
  id?: string;
  "aria-describedby"?: string;
}

/** The other names of a level in the hint: "also mail.example.com, www.example.com and the rest" (never the host's own name). */
function alsoHint(level: string, host: string): string {
  const [a, b] = ["mail", "www", "shop"].map((label) => `${label}.${level}`).filter((name) => name !== host);
  return s.allHint(showHost(a ?? `mail.${level}`).text, showHost(b ?? `www.${level}`).text);
}

/**
 * Which pages of a website open (UI pass, add-app plan section 6): the address drawn with its parts, a radio group of levels ("Only
 * shop.example.com" / "All of example.com"), the other sites it needs as chips with sign-in buttons, and a live preview of what opens and
 * what is blocked. The data model is unchanged: the picker only writes plain names (`example.com`), because every entry already includes
 * everything under it. The drawn address is a mouse and touch shortcut (hidden from screen readers); the radio group is the real control.
 */
export function SiteAccessPicker({ url, value, onChange, browser, suggestions = DEFAULT_SUGGESTIONS, error, disabled = false, withPreview = true, id, "aria-describedby": describedBy }: SiteAccessPickerProps) {
  const address = withHttps(url);
  const own = parseAddress(address);
  const options = own === null ? [] : levels(own.host);
  const selected = own === null ? "" : selectedLevel(own.host, value);
  const levelKeys = new Set(options);
  const others = own === null ? [] : value.filter((e) => !levelKeys.has(entryKey(e)));
  const hasStar = value.some((e) => e.trim().startsWith("*."));

  function choose(level: string) {
    if (own === null || disabled || level === selected) return;
    onChange(withLevel(own.host, value, level));
  }

  return (
    <div className="web-access" id={id}>
      <FieldSet legend={s.label} info={s.info} error={error}>
        {own === null ? (
          <p className="web-access__muted">{url.trim() === "" ? s.noAddress : s.invalidAddress}</p>
        ) : (
          <>
            <Drawing own={own} options={options} selected={selected} disabled={disabled} onChoose={choose} />
            {options.length > 1 ? (
              <Levels host={own.host} options={options} selected={selected} disabled={disabled} invalid={Boolean(error)} describedBy={describedBy} onChoose={choose} />
            ) : (
              <p className="web-access__single">{own.isIp ? s.ip : s.single(showHost(own.host).text)}</p>
            )}
            {hasStar && options.some((o) => value.some((e) => entryKey(e) === o && e.trim().startsWith("*."))) ? <p className="web-access__star">{s.wildcardNote}</p> : null}
            <SiteChips
              legend={s.others}
              info={s.othersInfo}
              value={value}
              chips={others}
              onChange={onChange}
              max={MAX_EXTRA_SITES}
              maxText={s.max}
              noneText={s.none}
              suggestions={suggestions}
              suggestLabel={s.suggest}
              addLabel={s.addLabel}
              addPlaceholder={s.addPlaceholder}
              addHint={s.addHint}
              reserved={[own.host]}
              isIncluded={(entry) => alreadyIncluded(address, value, entry)}
              disabled={disabled}
            />
          </>
        )}
      </FieldSet>
      {withPreview ? <SitePreview url={url} value={value} browser={browser} /> : null}
    </div>
  );
}

/** The address with its parts as buttons (mouse and touch); the part from the chosen level on is filled, the names in front of it dashed. */
function Drawing({ own, options, selected, disabled, onChoose }: { own: ParsedAddress; options: string[]; selected: string; disabled: boolean; onChoose: (level: string) => void }) {
  const broadest = options[options.length - 1] ?? own.host;
  const prefix = own.host === broadest ? [] : own.host.slice(0, own.host.length - broadest.length - 1).split(".");
  const parts = [...prefix, broadest];
  const first = parts.findIndex((_, j) => parts.slice(j).join(".") === selected);
  const from = first < 0 ? 0 : first;
  return (
    <div className="web-addr" aria-hidden="true">
      <span className="web-addr__scheme">https://</span>
      {parts.map((part, j) => {
        const level = parts.slice(j).join(".");
        const pickable = options.length > 1 && options.includes(level) && !disabled;
        const shown = showHost(part);
        return (
          <Fragment key={level}>
            {j > 0 ? <span className="web-addr__dot">.</span> : null}
            <button
              type="button"
              tabIndex={-1}
              className="web-addr__part"
              data-state={j >= from ? "in" : "under"}
              disabled={!pickable}
              title={pickable ? (level === own.host ? s.only(showHost(level).text) : s.all(showHost(level).text)) : undefined}
              onClick={() => onChoose(level)}
            >
              {shown.text}
            </button>
          </Fragment>
        );
      })}
      {own.port !== null ? <span className="web-addr__rest">:{own.port}</span> : null}
      {own.path !== "/" ? <span className="web-addr__rest">{own.path}</span> : null}
    </div>
  );
}

/** The levels as a radio group with a roving tab stop: arrows, Home and End move and choose. */
function Levels({ host, options, selected, disabled, invalid, describedBy, onChoose }: { host: string; options: string[]; selected: string; disabled: boolean; invalid: boolean; describedBy?: string; onChoose: (level: string) => void }) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(to: number) {
    const i = (to + options.length) % options.length;
    const level = options[i];
    if (level === undefined) return;
    onChoose(level);
    refs.current[i]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const at = Math.max(0, options.indexOf(selected));
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        move(at + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        move(at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(options.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div className="web-levels" role="radiogroup" aria-label={s.label} aria-describedby={describedBy} aria-invalid={invalid ? true : undefined} onKeyDown={onKeyDown}>
      {options.map((level, i) => {
        const checked = level === selected;
        const shown = showHost(level);
        const label = i === 0 ? s.only(shown.text) : s.all(shown.text);
        return (
          <button
            key={level}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            className="web-level"
            aria-checked={checked}
            aria-labelledby={`${base}-${i}-l`}
            aria-describedby={i > 0 ? `${base}-${i}-h` : undefined}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            title={shown.title}
            onClick={() => onChoose(level)}
          >
            <span className="web-level__dot" aria-hidden="true" />
            <span className="web-level__text">
              <span className="web-level__label" id={`${base}-${i}-l`}>
                {label}
              </span>
              {i > 0 ? (
                <span className="web-level__hint" id={`${base}-${i}-h`}>
                  {alsoHint(level, host)}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

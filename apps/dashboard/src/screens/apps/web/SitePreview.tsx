import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Input } from "@rulebox/ui";
import IconBlocked from "~icons/solar/close-circle-linear";
import IconDown from "~icons/solar/alt-arrow-down-linear";
import IconOpen from "~icons/solar/check-circle-linear";
import type { BrowserKind } from "../../../data/types";
import { decide, parseAddress, samples, type DecisionReason, type Sample } from "../../../lib/apps/siteAccess";
import { appSiteAccessStrings } from "../../../lib/screenStrings/appSiteAccess";
import { showAddress, withHttps } from "./webAddress";
import "./web.css";

const s = appSiteAccessStrings;
const p = s.preview;

/** The value after it has stayed the same for `ms` (what a screen reader hears: not every key press). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const NARROW = "(max-width: 599px)";
function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const narrowNow = (): boolean => typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;

/** What a row says besides the address: what kind of address it is, and for a blocked one the reason when it is not just "not on the list". */
function describe(sample: { kind: Sample["kind"]; open: boolean; reason: DecisionReason }): string {
  const kind = p.kinds[sample.kind];
  return !sample.open && sample.reason !== "not_listed" ? `${kind}, ${p.reasons[sample.reason]}` : kind;
}

function Row({ address, open, text }: { address: string; open: boolean; text: string }) {
  const shown = showAddress(address);
  return (
    <li className="web-row" data-open={open ? "true" : "false"}>
      <code className="web-row__addr" title={shown.title}>
        {shown.text}
      </code>
      <span className="web-row__what">{text}</span>
      <span className="web-state" data-open={open ? "true" : "false"}>
        <span className="dash-sr">, </span>
        {open ? <IconOpen aria-hidden="true" /> : <IconBlocked aria-hidden="true" />}
        {open ? p.open : p.blocked}
      </span>
    </li>
  );
}

export interface SitePreviewProps {
  /** The form's address (`https://` is added when it is missing). */
  url: string;
  /** The extra entries (the address's own host excluded). */
  value: readonly string[];
  /** Edge or Chrome: a footnote that all browser websites on a PC share one list. */
  browser?: BrowserKind;
  className?: string;
}

/**
 * "What employees can open": up to seven example addresses with "Opens" or "Blocked" in words (not only colour), and "Try an address" that
 * answers with the same rules the PC uses (`decide`). Changes are announced politely once, half a second after the last one.
 */
export function SitePreview({ url, value, browser, className }: SitePreviewProps) {
  const titleId = useId();
  const listId = useId();
  const tryId = useId();
  const address = withHttps(url);
  const own = parseAddress(address);
  const key = value.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => samples(address, value), [address, key]);
  const open = rows.filter((r) => r.open).length;
  const summary = p.summary(open, rows.length - open);
  const announced = useSettled(summary, 500);

  const narrow = useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
  const [collapsed, setCollapsed] = useState(true);
  const hidden = narrow && collapsed;

  const [typed, setTyped] = useState("");
  const tryText = typed.trim();
  const tried = own !== null && tryText !== "" ? decide(address, withHttps(tryText), value) : null;
  const triedAddress = tried !== null ? showAddress(withHttps(tryText)).text : "";
  const triedAnswer = tried === null ? "" : `${triedAddress}: ${tried.open ? p.tryOpen : p.tryBlocked}${tried.open ? "" : `, ${p.reasons[tried.reason]}`}`;
  const triedSettled = useSettled(triedAnswer, 500);

  const notes: string[] = [];
  if (own !== null) {
    if (own.path !== "/" && own.path !== "") notes.push(p.pathNote(own.path));
    if (own.port !== null) notes.push(p.portNote(own.port));
    if (browser === "edge" || browser === "chrome") notes.push(p.browserNote);
  }

  function onTryKey(e: KeyboardEvent<HTMLInputElement>) {
    // Inside the app's form: Enter answers, it never saves the app.
    if (e.key === "Enter") e.preventDefault();
  }

  return (
    <div className={["web-prev", className ?? ""].filter(Boolean).join(" ")} role="group" aria-labelledby={titleId}>
      <div className="web-prev__head">
        <h3 className="web-prev__title" id={titleId}>
          {p.title}
        </h3>
        {rows.length > 0 ? (
          narrow ? (
            <button type="button" className="web-prev__toggle" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed((c) => !c)}>
              {summary}
              <IconDown aria-hidden="true" />
            </button>
          ) : (
            <p className="web-prev__count">{summary}</p>
          )
        ) : null}
      </div>

      {own === null ? (
        <p className="web-prev__empty">{url.trim() === "" ? s.noAddress : s.invalidAddress}</p>
      ) : (
        <>
          <ul id={listId} className="web-prev__list" hidden={hidden}>
            {rows.map((r) => (
              <Row key={r.address} address={r.address} open={r.open} text={describe(r)} />
            ))}
          </ul>
          {notes.length > 0 ? (
            <ul className="web-prev__notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <div className="web-try">
            <label className="dash-field__label" htmlFor={tryId}>
              {p.try}
            </label>
            <Input id={tryId} value={typed} placeholder={p.tryPlaceholder} spellCheck={false} autoCapitalize="off" autoComplete="off" inputMode="url" onChange={(e) => setTyped(e.target.value)} onKeyDown={onTryKey} />
            {tried !== null ? (
              <p className="web-try__answer" data-open={tried.open ? "true" : "false"}>
                {tried.open ? <IconOpen aria-hidden="true" /> : <IconBlocked aria-hidden="true" />}
                <span>{triedAnswer}</span>
              </p>
            ) : null}
            <p className="dash-sr" role="status" aria-live="polite">
              {triedSettled}
            </p>
          </div>
        </>
      )}
      <p className="dash-sr" role="status" aria-live="polite">
        {rows.length > 0 ? announced : ""}
      </p>
    </div>
  );
}

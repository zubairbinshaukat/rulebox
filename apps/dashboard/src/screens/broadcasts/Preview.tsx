import type { BroadcastStyle } from "../../data/types";
import { broadcastStrings as b, lockStrings as l } from "./strings";

/**
 * A drawing of a PC with the message on it (UI pass): the desktop in miniature, the banner on top or the full-screen notice
 * over it. Not the Staff App. The text is rendered as TEXT (React escapes it, line breaks are kept with `white-space: pre-wrap`
 * in CSS), so markup typed into the form is shown as typed here too. Empty fields show a muted placeholder.
 */
export function BroadcastPreview({ style, title, body, ackRequired }: { style: BroadcastStyle; title: string; body: string; ackRequired: boolean }) {
  const shownTitle = title.trim();
  const shownBody = body.trim();
  const titleText = shownTitle || <span className="bc-ph">{b.previewTitleHolder}</span>;
  const bodyText = shownBody || <span className="bc-ph">{b.previewBodyHolder}</span>;
  return (
    <figure className="bc-prev" aria-label={b.preview}>
      <figcaption className="bc-prev__cap">
        <strong>{b.preview}</strong>
        <span>{b.previewHint}</span>
      </figcaption>
      <div className="bc-screen" data-style={style}>
        <div className="bc-screen__desk" aria-hidden="true">
          <i className="bc-screen__hello" />
          <i className="bc-screen__tile" />
          <i className="bc-screen__tile" />
          <i className="bc-screen__tile" />
          <i className="bc-screen__tile" />
        </div>
        <div className="bc-screen__bar" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {style === "banner" ? (
          <div className="bc-banner" role="note">
            <span className="bc-banner__text">
              <strong>{titleText}</strong> <span className="bc-banner__sep">&mdash;</span> {bodyText}
            </span>
            <span className={ackRequired ? "bc-btn" : "bc-btn bc-btn--quiet"}>{ackRequired ? b.ok : b.dismiss}</span>
          </div>
        ) : (
          <div className="bc-cover">
            <div className="bc-note" role="note">
              <strong className="bc-note__title">{titleText}</strong>
              <p className="bc-note__body">{bodyText}</p>
              <span className="bc-btn">{b.ok}</span>
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}

/** The two drawings on the style cards: a strip along the top, or a card over a dimmed screen. Decorative (the card carries the words). */
export function StyleArt({ style }: { style: BroadcastStyle }) {
  return (
    <span className="bc-art" data-style={style}>
      <i className="bc-art__strip" />
      <i className="bc-art__card" />
      <i className="bc-art__line" />
      <i className="bc-art__line bc-art__line--short" />
    </span>
  );
}

/** The lock view of a PC: organization name, message, contact; no sign-in form. */
export function LockPreview({ orgName, message, contact }: { orgName: string; message: string; contact: string }) {
  const text = message.trim();
  const who = contact.trim();
  return (
    <figure className="dash-preview" aria-label={l.preview}>
      <figcaption className="dash-preview__cap">{l.preview}</figcaption>
      <div className="dash-preview__screen dash-preview__screen--cover">
        <div className="dash-preview__card" role="note">
          <span className="dash-preview__org">{l.previewOrg(orgName)}</span>
          <p className="dash-preview__body">{text || l.messageDefault}</p>
          {who ? <p className="dash-preview__contact">{l.previewContact(who)}</p> : null}
        </div>
      </div>
    </figure>
  );
}

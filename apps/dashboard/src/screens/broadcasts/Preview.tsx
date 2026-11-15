import type { BroadcastStyle } from "../../data/types";
import { broadcastStrings as b, lockStrings as l } from "./strings";

/**
 * Previews of what a PC shows (plan 4.17): a miniature, not the Staff App. The text is rendered as TEXT (React escapes it,
 * line breaks are kept with `white-space: pre-wrap` in CSS), so markup typed into a form is shown as typed here too.
 */
export function BroadcastPreview({ style, title, body, ackRequired }: { style: BroadcastStyle; title: string; body: string; ackRequired: boolean }) {
  const shownTitle = title.trim();
  const shownBody = body.trim();
  return (
    <figure className="dash-preview" aria-label={b.preview}>
      <figcaption className="dash-preview__cap">{style === "banner" ? b.previewBanner : b.previewFullscreen}</figcaption>
      {style === "banner" ? (
        <div className="dash-preview__screen">
          <div className="dash-preview__banner" role="note">
            <span className="dash-preview__text">
              <strong>{shownTitle}</strong>
              {shownBody ? <span> {shownBody}</span> : null}
            </span>
            {ackRequired ? <span className="dash-preview__btn">{b.ok}</span> : <span className="dash-preview__btn dash-preview__btn--quiet">{b.dismiss}</span>}
          </div>
        </div>
      ) : (
        <div className="dash-preview__screen dash-preview__screen--cover">
          <div className="dash-preview__card" role="note">
            <strong className="dash-preview__title">{shownTitle}</strong>
            {shownBody ? <p className="dash-preview__body">{shownBody}</p> : null}
            <span className="dash-preview__btn">{b.ok}</span>
          </div>
        </div>
      )}
    </figure>
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

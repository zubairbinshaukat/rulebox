import { useId, useMemo, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router";
import { Button } from "@rulebox/ui";
import IconDanger from "~icons/solar/danger-circle-linear";
import IconInfo from "~icons/solar/info-circle-linear";
import IconOk from "~icons/solar/check-circle-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import "./AttentionList.css";

export type AttentionTone = "danger" | "warning" | "info";

export type AttentionAction = { label: string; primary?: boolean } & ({ to: string; onClick?: never } | { onClick: () => void; to?: never });

export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  /** A Solar icon element. Default: the tone's own glyph (a circle for danger, a triangle for warning, an "i" for info). */
  icon?: ReactNode;
  title: string;
  body?: string;
  /** ONE thing to do about it: a link to a page or a button. The first action in the list is the main (filled) one. */
  action?: AttentionAction;
}

export interface AttentionListProps {
  items: readonly AttentionItem[];
  /** Cards shown before "Show all (n)". Default 5. */
  max?: number;
  /** Shown instead of the list when there is nothing to do ("Everything is fine"). Nothing is drawn when this is missing too. */
  emptyText?: string;
  /** A name for the list ("Needs attention"). */
  label?: string;
  /** Spoken before each title, so the tone is not only a colour. */
  toneWords?: Record<AttentionTone, string>;
  showAllText?: (n: number) => string;
  showFewerText?: string;
  className?: string;
}

type Glyph = ComponentType<SVGProps<SVGSVGElement>>;
const GLYPHS: Record<AttentionTone, Glyph> = { danger: IconDanger, warning: IconWarn, info: IconInfo };
const ORDER: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };
const TONE_WORDS: Record<AttentionTone, string> = { danger: "Urgent", warning: "Warning", info: "Note" };

/** Danger, then warning, then info; the caller's order is kept inside a tone. */
function sortAttention<T extends { tone: AttentionTone }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => ORDER[a.item.tone] - ORDER[b.item.tone] || a.index - b.index)
    .map((x) => x.item);
}

/**
 * "Needs attention": a card per thing, most urgent first, each with one thing to do. Looks like the device page's problem
 * cards. The list lays itself out by its own width: one column under 560 px, two from there; a phone puts the button under
 * the text. More than `max` cards fold behind "Show all (n)". The tone is spoken (a hidden word before the title) and drawn
 * as a different shape of icon, not only a colour.
 */
export function AttentionList({
  items,
  max = 5,
  emptyText,
  label,
  toneWords = TONE_WORDS,
  showAllText = (n) => `Show all (${n})`,
  showFewerText = "Show fewer",
  className,
}: AttentionListProps) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const sorted = useMemo(() => sortAttention(items), [items]);
  const shown = all ? sorted : sorted.slice(0, max);
  const primary = sorted.find((i) => i.action?.primary)?.key ?? sorted.find((i) => i.action)?.key;

  if (sorted.length === 0) {
    if (!emptyText) return null;
    return (
      <div className={["dash-attn-clear", "dash-enter", className ?? ""].filter(Boolean).join(" ")} role="status">
        <span className="dash-attn-clear__icon" aria-hidden="true">
          <IconOk />
        </span>
        <p className="dash-attn-clear__text">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className={["dash-attn", className ?? ""].filter(Boolean).join(" ")}>
      <ul id={listId} className="dash-attn__list" aria-label={label}>
        {shown.map((item, i) => {
          const Glyph = GLYPHS[item.tone];
          const filled = item.key === primary;
          return (
            <li key={item.key} className="dash-attn__wrap">
              <article className="dash-attn__card dash-enter" data-tone={item.tone} style={{ animationDelay: `${Math.min(i, 5) * 35}ms` }}>
                <span className="dash-attn__icon" aria-hidden="true">
                  {item.icon ?? <Glyph />}
                </span>
                <div className="dash-attn__text">
                  <h3 className="dash-attn__title">
                    <span className="dash-sr">{toneWords[item.tone]}: </span>
                    {item.title}
                  </h3>
                  {item.body ? <p className="dash-attn__body">{item.body}</p> : null}
                </div>
                {item.action ? (
                  <div className="dash-attn__action">
                    {item.action.to !== undefined ? (
                      <Link className={`rb-btn rb-btn--${filled ? "primary" : "ghost"}`} to={item.action.to}>
                        {item.action.label}
                      </Link>
                    ) : (
                      <Button variant={filled ? "primary" : "ghost"} onClick={item.action.onClick}>
                        {item.action.label}
                      </Button>
                    )}
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
      {sorted.length > max ? (
        <button type="button" className="dash-attn__toggle" aria-expanded={all} aria-controls={listId} onClick={() => setAll((x) => !x)}>
          {all ? showFewerText : showAllText(sorted.length)}
        </button>
      ) : null}
    </div>
  );
}

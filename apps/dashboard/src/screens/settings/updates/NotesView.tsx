import { useId, useMemo, useState } from "react";
import { notesBlocks, type NotesBlock } from "./releaseNotes";
import { updates as s } from "../strings";

/** More than this, or this many blocks, and the notes are clamped behind "Show notes". */
const SHORT_CHARS = 140;

/** The notes of a release as plain text: headings, bullets and paragraphs, never HTML, never a link. Clamped to a few lines until opened. */
export function NotesView({ notes, truncated }: { notes: string; truncated: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const blocks = useMemo(() => notesBlocks(notes), [notes]);
  if (blocks.length === 0) return null;
  const long = blocks.length > 2 || blocks.reduce((n, b) => n + b.text.length, 0) > SHORT_CHARS;
  const all = groups(blocks);
  // Closed, show whole blocks only (the first heading with what follows it), so the clamp never cuts a heading in half.
  const shown = open || !long ? all : all.slice(0, all[0]?.kind === "heading" ? 2 : 1);
  return (
    <div className="upd-notes" data-open={open || !long || undefined}>
      <div className="upd-notes__body" id={id}>
        {shown.map((g, i) =>
          g.kind === "bullets" ? (
            <ul key={i} className="upd-notes__list">
              {g.items.map((t, j) => (
                <li key={j}>{t}</li>
              ))}
            </ul>
          ) : (
            <p key={i} className={g.kind === "heading" ? "upd-notes__h" : "upd-notes__p"}>
              {g.text}
            </p>
          ),
        )}
        {open && truncated ? <p className="upd-notes__p upd-notes__more">{s.notesTruncated}</p> : null}
      </div>
      {long ? (
        <button type="button" className="upd-notes__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? s.hideNotes : s.showNotes}
        </button>
      ) : null}
    </div>
  );
}

type Group = { kind: "bullets"; items: string[] } | { kind: "heading" | "paragraph"; text: string };

/** Consecutive bullets become one list. */
function groups(blocks: readonly NotesBlock[]): Group[] {
  const out: Group[] = [];
  for (const b of blocks) {
    if (b.kind === "bullet") {
      const last = out[out.length - 1];
      if (last?.kind === "bullets") last.items.push(b.text);
      else out.push({ kind: "bullets", items: [b.text] });
    } else out.push({ kind: b.kind, text: b.text });
  }
  return out;
}

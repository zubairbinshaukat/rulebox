import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Button } from "@rulebox/ui";
import * as v from "../../lib/validate";
import { comboOfKeyEvent, keysOf } from "./hotkeyKeys";
import { exit as s, hotkeyMessage } from "./strings";

/** The keys as small key caps. */
export function KeyCaps({ keys, label }: { keys: readonly string[]; label?: string }) {
  return (
    <span className="set-keys" role={label ? "img" : undefined} aria-label={label}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="set-keys__item">
          {i > 0 ? <span className="set-keys__plus" aria-hidden="true">+</span> : null}
          <kbd className="set-keys__cap" aria-hidden={label ? true : undefined}>
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * The admin-exit key combination as key caps with a "Change" button: it records the keys the administrator presses. A lone modifier is
 * ignored, Esc or leaving cancels, a combination the grammar refuses says why and keeps listening, a valid one is handed over in
 * its canonical form. The browser keeps some combinations for itself (Alt+F4, Ctrl+W): the typed field under Advanced covers those.
 */
export function HotkeyRecorder({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (canonical: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pad = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (recording) pad.current?.focus();
  }, [recording]);

  const stop = () => {
    setRecording(false);
    setProblem(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      stop();
      return;
    }
    // Tab moves on (and, through the blur, cancels): a keyboard user is never trapped.
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboOfKeyEvent(e);
    if (combo === null) return;
    const r = v.parseHotkey(combo);
    if (!r.ok) {
      setProblem(hotkeyMessage(r));
      return;
    }
    onChange(r.canonical);
    stop();
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) stop();
  };

  if (!recording) {
    return (
      <div className="set-rec">
        <KeyCaps keys={keysOf(value)} label={s.hotkeyNow(keysOf(value).join(" + "))} />
        {!disabled ? (
          <Button variant="ghost" className="dash-btn--sm" onClick={() => setRecording(true)}>
            {s.change}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="set-rec set-rec--on">
      <div ref={pad} tabIndex={0} role="group" aria-label={s.recordingLabel} className="set-rec__pad" onKeyDown={onKeyDown} onBlur={onBlur}>
        <span className="set-rec__title">{s.recording}</span>
        <span className="set-rec__hint">{s.recordingHint}</span>
        {problem ? (
          <span className="set-rec__problem" role="alert">
            {problem}
          </span>
        ) : null}
      </div>
      <Button variant="ghost" className="dash-btn--sm" onClick={stop}>
        {s.recordingStop}
      </Button>
    </div>
  );
}

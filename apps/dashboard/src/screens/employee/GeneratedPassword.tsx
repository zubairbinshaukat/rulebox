import { useEffect, useRef, useState } from "react";
import { Button } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import IconCopy from "~icons/solar/copy-linear";
import IconRefresh from "~icons/solar/refresh-linear";
import { employeeStrings as s } from "../../lib/screenStrings/employee";

type CopyState = "idle" | "copied" | "manual";

/**
 * The generated password, big and easy to read out (`k7mq-p4xt-9wrb`), with Copy and, while it can still change, "Generate another".
 * Copy runs only when the person presses it (the async clipboard; without it the text is selected and the person is told to press
 * Ctrl+C). The value lives in the parent's state: it is never logged, stored or put in a URL.
 */
export function GeneratedPassword({
  value,
  labelledBy,
  onGenerate,
}: {
  value: string;
  /** The id of the visible label. */
  labelledBy: string;
  /** "Generate another"; leave out once the password is saved (hand-over). */
  onGenerate?: () => void;
}) {
  const text = useRef<HTMLElement>(null);
  // Remembers which password was copied: another password is not "copied" yet.
  const [done, setDone] = useState<{ value: string; state: CopyState } | null>(null);
  const state: CopyState = done !== null && done.value === value ? done.state : "idle";
  const setState = (next: CopyState) => setDone({ value, state: next });

  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setDone(null), 2000);
    return () => clearTimeout(t);
  }, [state]);

  function select() {
    const el = text.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function copy() {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        setState("copied");
        return;
      } catch {
        // Blocked or not focused: select it instead.
      }
    }
    select();
    setState("manual");
  }

  return (
    <div className="emp-pw">
      <div className="emp-pw__box">
        <code ref={text} className="emp-pw__value" aria-labelledby={labelledBy} onClick={select}>
          {value}
        </code>
        <Button variant="ghost" className="emp-pw__copy" onClick={() => void copy()}>
          {state === "copied" ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
          {state === "copied" ? s.copied : s.copy}
        </Button>
      </div>
      {onGenerate ? (
        <Button variant="ghost" className="dash-btn--sm emp-pw__again" onClick={onGenerate}>
          <IconRefresh aria-hidden="true" />
          {s.generate}
        </Button>
      ) : null}
      <p className="emp-pw__note" role="status" aria-live="polite">
        {state === "manual" ? s.copyManual : state === "copied" ? <span className="dash-sr">{s.copied}</span> : null}
      </p>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { Button, Input, Textarea } from "@rulebox/ui";
import IconCopy from "~icons/solar/copy-linear";
import IconCheck from "~icons/solar/check-circle-linear";
import { strings } from "../lib/strings";

export interface CopyFieldProps {
  value: string;
  label: string;
  /** Long values (an enrollment command) wrap in a read-only textarea. */
  multiline?: boolean;
  /** Visible label (default: screen-reader only). */
  showLabel?: boolean;
}

type CopyState = "idle" | "copied" | "manual";

/**
 * A read-only value with a Copy button. Uses the async clipboard when the
 * page is a secure context; otherwise (plain http, old browsers, denied
 * permission) it selects the text and asks the user to press Ctrl+C.
 */
export function CopyField({ value, label, multiline, showLabel }: CopyFieldProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);

  function selectAll() {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
    el.setSelectionRange?.(0, value.length);
  }

  async function copy() {
    if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        setState("copied");
        return;
      } catch {
        // Permission denied or not focused: fall through to manual copy.
      }
    }
    selectAll();
    setState("manual");
  }

  const common = {
    id,
    ref,
    value,
    readOnly: true,
    spellCheck: false,
    onFocus: selectAll,
    "aria-describedby": state === "manual" ? `${id}-manual` : undefined,
  };

  return (
    <div className="dash-field">
      <label htmlFor={id} className={showLabel ? "dash-field__label" : "dash-sr"}>
        {label}
      </label>
      <div className="dash-copy">
        {multiline ? <Textarea {...common} rows={3} /> : <Input {...common} />}
        <Button variant="ghost" className="dash-copy__btn" onClick={copy}>
          {state === "copied" ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
          {state === "copied" ? strings.common.copied : strings.common.copy}
        </Button>
      </div>
      <p className="dash-field__hint" role="status" aria-live="polite" id={`${id}-manual`}>
        {state === "manual" ? strings.common.copyFailed : state === "copied" ? <span className="dash-sr">{strings.common.copied}</span> : null}
      </p>
    </div>
  );
}

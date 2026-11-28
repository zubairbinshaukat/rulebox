import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@rulebox/ui";
import IconCopy from "~icons/solar/copy-linear";
import IconCheck from "~icons/solar/check-circle-linear";
import { deviceText as t } from "./strings";

export interface TechItem {
  label: string;
  value: string;
  /** Monospace (ids, codes, commands). */
  mono?: boolean;
}

/**
 * "Technical details": raw codes, ids and commands that only support needs, one click deeper (`dash-advanced`) with a Copy button
 * for all of it. Closed by default; renders nothing without items. Never put a sentence a normal user must read in here.
 */
export function TechnicalDetails({ items, label = t.tech, className }: { items: TechItem[]; label?: string; className?: string }) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const text = items.map((i) => `${i.label}: ${i.value}`).join("\n");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    if (state === "manual") area.current?.select();
  }, [state]);

  if (items.length === 0) return null;

  async function copy() {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        setState("copied");
        return;
      } catch {
        // Permission denied or the page is not focused: fall back to selecting the text.
      }
    }
    setState("manual");
  }

  return (
    <details className={["dash-advanced", "dev-tech", className ?? ""].filter(Boolean).join(" ")}>
      <summary>{label}</summary>
      <div className="dash-advanced__body dev-tech__body">
        <p className="dev-tech__lead">{t.techLead}</p>
        <dl className="dev-tech__list">
          {items.map((i, index) => (
            <div className="dev-tech__row" key={`${i.label}:${index}`}>
              <dt>{i.label}</dt>
              <dd className={i.mono === false ? undefined : "dash-mono"}>{i.value}</dd>
            </div>
          ))}
        </dl>
        <div className="dev-tech__foot">
          <Button variant="ghost" className="dash-btn--sm" onClick={copy} aria-describedby={`${id}-status`}>
            {state === "copied" ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
            {state === "copied" ? t.techCopied : t.techCopy}
          </Button>
          <span id={`${id}-status`} className="dev-tech__status" role="status" aria-live="polite">
            {state === "manual" ? t.techManual : ""}
          </span>
        </div>
        {state === "manual" ? <textarea ref={area} className="dev-tech__area" readOnly rows={Math.min(8, items.length + 1)} value={text} aria-label={label} /> : null}
      </div>
    </details>
  );
}

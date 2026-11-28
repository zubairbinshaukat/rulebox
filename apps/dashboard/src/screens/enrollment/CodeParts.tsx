import { useRef, type Ref } from "react";
import { Button } from "@rulebox/ui";
import IconCopy from "~icons/solar/copy-linear";
import IconCheck from "~icons/solar/check-circle-linear";
import { strings } from "../../lib/strings";
import { codeBlocks } from "./model";
import { enrollText as s } from "./strings";
import { useCopy, type CopyStatus } from "./useCopy";

/**
 * The code in blocks of four for reading aloud. Display only: the blocks are inline spans with no characters between them (a `<wbr>` lets
 * the line break there), so selecting the code and copying it gives the exact text.
 */
export function CodeBlocks({ code, compact = false, innerRef }: { code: string; compact?: boolean; innerRef?: Ref<HTMLParagraphElement> }) {
  return (
    <p className={compact ? "addpc-blocks addpc-blocks--compact" : "addpc-blocks"} translate="no" ref={innerRef} data-testid="code-blocks">
      {codeBlocks(code).map((b, i) => (
        <span key={i}>
          {i > 0 ? <wbr /> : null}
          <span className="addpc-blocks__b">{b}</span>
        </span>
      ))}
    </p>
  );
}

/** "Copy" that turns into "Copied" for two seconds. */
export function CopyLabel({ status, label = s.copy }: { status: CopyStatus; label?: string }) {
  return (
    <>
      {status === "copied" ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
      {status === "copied" ? s.copied : label}
    </>
  );
}

/** One line to copy (the installer command, the agent's command): the text, then a Copy button; the text is selected when the clipboard is not available. */
export function CommandLine({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLElement>(null);
  const { status, copy } = useCopy(text, ref);
  return (
    <div className="addpc-cmd">
      <p className="addpc-cmd__label">{label}</p>
      <div className="addpc-cmd__row">
        <code className="addpc-cmd__text" ref={ref} translate="no">
          {text}
        </code>
        <Button variant="ghost" className="dash-btn--sm" onClick={() => void copy()} aria-label={`${s.copy}: ${label}`}>
          <CopyLabel status={status} label={strings.common.copy} />
        </Button>
      </div>
      <p className="addpc-cmd__manual" role="status" aria-live="polite">
        {status === "manual" ? s.copyManual : status === "copied" ? <span className="dash-sr">{s.copied}</span> : null}
      </p>
    </div>
  );
}

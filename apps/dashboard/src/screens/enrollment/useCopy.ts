import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type CopyStatus = "idle" | "copied" | "manual";

/**
 * "Copy" with one click. The async clipboard in a secure context; otherwise (plain http, an old browser, a denied permission) the text
 * on screen is selected (`target`, the element that shows the same text) and the status turns "manual": the screen then asks for
 * Ctrl+C. The copied text is exactly `value`; what is selected for the fallback is the visible element, whose text is the same.
 */
export function useCopy(value: string, target: RefObject<HTMLElement | null>): { status: CopyStatus; copy: () => Promise<void> } {
  const [status, setStatus] = useState<CopyStatus>("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const t = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(t);
  }, [status]);

  const copy = useCallback(async () => {
    if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        setStatus("copied");
        return;
      } catch {
        // Permission denied or the page is not focused: fall through to a manual copy.
      }
    }
    const el = target.current;
    if (el) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    setStatus("manual");
  }, [value, target]);

  // A new value (a new code) starts from "idle".
  const last = useRef(value);
  useEffect(() => {
    if (last.current !== value) {
      last.current = value;
      setStatus("idle");
    }
  }, [value]);

  return { status, copy };
}

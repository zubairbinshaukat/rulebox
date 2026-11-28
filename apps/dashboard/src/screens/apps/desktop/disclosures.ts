import { useState } from "react";

/** The form fields that live inside "Advanced": an error in one of them opens it. */
export const ADVANCED_FIELDS = ["sha256", "installUrl", "silentArgs", "successCodes", "timeoutMin", "installPublisher", "answerUrl", "answerSha256", "productCode", "args", "fileArg", "resetFolders"] as const;
/** The form fields that live inside "More options". */
export const MORE_FIELDS = ["description", "publisher"] as const;

/** Open "More options" and "Advanced" by themselves when a problem is inside them (so an error is never hidden). */
export function useDisclosures(errors: Record<string, string | undefined>, linkHere: boolean) {
  const [more, setMore] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const problem = (keys: readonly string[]) => keys.some((k) => errors[k] !== undefined && (linkHere || k !== "installUrl"));
  const wantMore = problem(MORE_FIELDS);
  const wantAdvanced = problem(ADVANCED_FIELDS);
  // A problem opens its disclosure once; the person can close it again.
  const [seen, setSeen] = useState({ more: false, advanced: false });
  if (wantMore && !seen.more) {
    setSeen((s) => ({ ...s, more: true }));
    setMore(true);
  }
  if (wantAdvanced && !seen.advanced) {
    setSeen((s) => ({ ...s, advanced: true }));
    setAdvanced(true);
  }
  return { more, setMore, advanced, setAdvanced };
}


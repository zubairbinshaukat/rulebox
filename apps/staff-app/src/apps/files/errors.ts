import type { FileError } from "@rulebox/types";

import { formatBytes } from "./storage";
import { nameRuleMessage } from "./validation";

export function isFileError(value: unknown): value is FileError {
  return typeof value === "object" && value !== null && "kind" in value;
}

/** What to tell a person when a file command failed. `name` is the item involved, when known. */
export function fileErrorText(error: unknown, name?: string): string {
  if (!isFileError(error)) {
    return typeof error === "string" && error ? error : "Something went wrong.";
  }
  switch (error.kind) {
    case "invalidName":
      return nameRuleMessage(error.rule);
    case "notFound":
      return name ? `“${name}” is no longer there.` : "That item is no longer there.";
    case "exists":
      return "Something with that name already exists.";
    case "isReparsePoint":
    case "outsideRoot":
      return "That item can't be used here.";
    case "quotaExceeded":
      return error.shortBy <= 1
        ? "Storage is full. Delete files to save new ones."
        : `Storage is full. ${formatBytes(error.shortBy)} more space is needed.`;
    case "blockedType":
      return "This type of file can't be opened on this PC.";
    case "tooLarge":
      return "That is too large to handle here.";
    case "damaged":
      return "That file looks damaged.";
    case "intoItself":
      return "A folder can't be moved inside itself.";
    case "notSignedIn":
      return "You are not signed in.";
    case "io":
      return error.message || "Something went wrong.";
  }
}

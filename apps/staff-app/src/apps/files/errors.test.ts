import { describe, expect, it } from "vitest";
import type { FileError } from "@rulebox/types";

import { fileErrorText, isFileError } from "./errors";

describe("file error messages", () => {
  const cases: [FileError, string | RegExp][] = [
    [{ kind: "invalidName", rule: "reservedName" }, "That name is reserved by Windows."],
    [{ kind: "notFound" }, "That item is no longer there."],
    [{ kind: "exists" }, "Something with that name already exists."],
    [{ kind: "isReparsePoint" }, "That item can't be used here."],
    [{ kind: "outsideRoot" }, "That item can't be used here."],
    [{ kind: "quotaExceeded", shortBy: 1 }, "Storage is full. Delete files to save new ones."],
    [{ kind: "quotaExceeded", shortBy: 2_097_152 }, "Storage is full. 2 MB more space is needed."],
    [{ kind: "blockedType" }, "This type of file can't be opened on this PC."],
    [{ kind: "tooLarge" }, "That is too large to handle here."],
    [{ kind: "damaged" }, "That file looks damaged."],
    [{ kind: "intoItself" }, "A folder can't be moved inside itself."],
    [{ kind: "notSignedIn" }, "You are not signed in."],
    [{ kind: "io", message: "disk is read-only" }, "disk is read-only"],
  ];

  it.each(cases)("says the right thing for %j", (error, text) => {
    expect(fileErrorText(error)).toBe(text);
  });

  it("names the item when it is gone", () => {
    expect(fileErrorText({ kind: "notFound" }, "Report.pdf")).toBe("“Report.pdf” is no longer there.");
  });

  it("copes with things that are not file errors", () => {
    expect(isFileError({ kind: "exists" })).toBe(true);
    expect(isFileError("boom")).toBe(false);
    expect(isFileError(null)).toBe(false);
    expect(fileErrorText("boom")).toBe("boom");
    expect(fileErrorText(new Error("x"))).toBe("Something went wrong.");
    expect(fileErrorText(undefined)).toBe("Something went wrong.");
  });
});

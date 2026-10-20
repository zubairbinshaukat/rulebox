import { describe, expect, it } from "vitest";
import {
  nameRuleMessage,
  splitBaseAndExt,
  validateName,
} from "./validation";

describe("name validation and rename messages", () => {
  it("rejects empty names", () => {
    const res = validateName("");
    expect(res.valid).toBe(false);
    expect(res.rule).toBe("empty");
    expect(res.message).toBe("A name can't be empty.");
  });

  it("rejects dot and double-dot names", () => {
    const dot = validateName(".");
    expect(dot.valid).toBe(false);
    expect(dot.rule).toBe("dotName");
    expect(dot.message).toBe("A name can't be just dots.");

    const dotDot = validateName("..");
    expect(dotDot.valid).toBe(false);
    expect(dotDot.rule).toBe("dotName");
    expect(dotDot.message).toBe("A name can't be just dots.");
  });

  it("rejects bad characters", () => {
    const badChars = ["<", ">", ":", '"', "/", "\\", "|", "?", "*", "a/b", "c:d", "x*y"];
    for (const name of badChars) {
      const res = validateName(name);
      expect(res.valid).toBe(false);
      expect(res.rule).toBe("badCharacter");
      expect(res.message).toBe('A name can\'t contain any of  < > : " / \\ | ? *');
    }
  });

  it("rejects control characters", () => {
    const res = validateName("test\x00file");
    expect(res.valid).toBe(false);
    expect(res.rule).toBe("badCharacter");
    expect(res.message).toBe('A name can\'t contain any of  < > : " / \\ | ? *');
  });

  it("rejects text-direction override characters", () => {
    const res = validateName("file\u202Ereversed");
    expect(res.valid).toBe(false);
    expect(res.rule).toBe("direction");
    expect(res.message).toBe("A name can't contain text-direction characters.");
  });

  it("rejects trailing dot or space", () => {
    const trailingDot = validateName("filename.");
    expect(trailingDot.valid).toBe(false);
    expect(trailingDot.rule).toBe("trailingDotOrSpace");
    expect(trailingDot.message).toBe("A name can't end with a dot or a space.");

    const trailingSpace = validateName("filename ");
    expect(trailingSpace.valid).toBe(false);
    expect(trailingSpace.rule).toBe("trailingDotOrSpace");
    expect(trailingSpace.message).toBe("A name can't end with a dot or a space.");
  });

  it("rejects names longer than 255 code units", () => {
    const longName = "a".repeat(256);
    const res = validateName(longName);
    expect(res.valid).toBe(false);
    expect(res.rule).toBe("tooLong");
    expect(res.message).toBe("That name is too long.");
  });

  it("rejects reserved Windows device names", () => {
    const reserved = ["CON", "prn", "aux.txt", "NUL.pdf", "COM1", "lpt3", "com1.log"];
    for (const name of reserved) {
      const res = validateName(name);
      expect(res.valid).toBe(false);
      expect(res.rule).toBe("reservedName");
      expect(res.message).toBe("That name is reserved by Windows.");
    }
  });

  it("rejects superscript reserved device names", () => {
    const res = validateName("COM¹");
    expect(res.valid).toBe(false);
    expect(res.rule).toBe("reservedName");
  });

  it("rejects Rulebox internal prefix", () => {
    const res = validateName(".rulebox-trash");
    expect(res.valid).toBe(false);
    expect(res.rule).toBe("internal");
    expect(res.message).toBe("That name is reserved by Rulebox.");
  });

  it("accepts valid names", () => {
    const valid = [
      "My Document.pdf",
      "photo_2026.png",
      "Project (1).docx",
      "notes",
      "123-abc",
      ".gitignore",
    ];
    for (const name of valid) {
      const res = validateName(name);
      expect(res.valid).toBe(true);
      expect(res.message).toBeUndefined();
    }
  });

  it("nameRuleMessage handles every rule correctly", () => {
    expect(nameRuleMessage("empty")).toBe("A name can't be empty.");
    expect(nameRuleMessage("dotName")).toBe("A name can't be just dots.");
    expect(nameRuleMessage("badCharacter")).toBe('A name can\'t contain any of  < > : " / \\ | ? *');
    expect(nameRuleMessage("trailingDotOrSpace")).toBe("A name can't end with a dot or a space.");
    expect(nameRuleMessage("reservedName")).toBe("That name is reserved by Windows.");
    expect(nameRuleMessage("tooLong")).toBe("That name is too long.");
    expect(nameRuleMessage("direction")).toBe("A name can't contain text-direction characters.");
    expect(nameRuleMessage("internal")).toBe("That name is reserved by Rulebox.");
  });

  it("splitBaseAndExt separates base name and extension for F2 selection", () => {
    expect(splitBaseAndExt("report.pdf")).toEqual({ base: "report", ext: ".pdf" });
    expect(splitBaseAndExt("archive.tar.gz")).toEqual({ base: "archive.tar", ext: ".gz" });
    expect(splitBaseAndExt("README")).toEqual({ base: "README", ext: "" });
    expect(splitBaseAndExt(".hidden")).toEqual({ base: ".hidden", ext: "" });
  });
});

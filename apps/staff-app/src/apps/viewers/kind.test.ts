import { describe, expect, it } from "vitest";

import { extensionOf, fileNameOf, isVideo, mediaMime, rbfileUrl, viewerKindFor } from "./kind";

describe("which viewer shows a file", () => {
  // The same expectations as the Rust test of `opener_for` / `viewer_for_name`.
  const cases: [string, string | null][] = [
    ["photo.JPG", "image"],
    ["a.jpeg", "image"],
    ["a.png", "image"],
    ["a.gif", "image"],
    ["a.webp", "image"],
    ["song.mp3", "media"],
    ["a.wav", "media"],
    ["a.m4a", "media"],
    ["a.aac", "media"],
    ["a.ogg", "media"],
    ["clip.mp4", "media"],
    ["a.webm", "media"],
    ["A.PDF", "pdf"],
    ["notes.txt", "text"],
    ["sales.csv", "csv"],
    ["letter.docx", "docx"],
    ["budget.xlsx", "xlsx"],
    ["movie.mkv", null],
    ["archive.zip", null],
    ["noextension", null],
    ["a.pdf.exe", null],
    [".hidden", null],
  ];

  it.each(cases)("%s -> %s", (name, kind) => {
    expect(viewerKindFor(name)).toBe(kind);
  });

  it("reads the last extension after trimming dots and spaces, like the backend", () => {
    expect(extensionOf("a.TXT")).toBe("txt");
    expect(extensionOf("a.txt. ")).toBe("txt");
    expect(extensionOf("a.tar.gz")).toBe("gz");
    expect(extensionOf("noext")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });

  it("knows audio from video", () => {
    expect(isVideo("a.mp4")).toBe(true);
    expect(isVideo("a.webm")).toBe(true);
    expect(isVideo("a.mp3")).toBe(false);
    expect(mediaMime("a.mp3")).toBe("audio/mpeg");
    expect(mediaMime("a.png")).toBeNull();
  });

  it("takes the file name from a relative path", () => {
    expect(fileNameOf("Docs/Taxes/2024.pdf")).toBe("2024.pdf");
    expect(fileNameOf("a.txt")).toBe("a.txt");
  });
});

describe("rbfile addresses", () => {
  it("encodes every part of the path and keeps the slashes", () => {
    expect(rbfileUrl("My Docs/é #1?.txt")).toBe("http://rbfile.localhost/My%20Docs/%C3%A9%20%231%3F.txt");
    expect(rbfileUrl("a.txt")).toBe("http://rbfile.localhost/a.txt");
  });
});

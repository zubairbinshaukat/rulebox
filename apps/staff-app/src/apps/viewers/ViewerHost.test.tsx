import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ViewerHost } from "./ViewerHost";

// Each viewer is replaced by a label, so the test is about which one is chosen.
vi.mock("./ImageViewer", () => ({ default: () => <div>image viewer</div> }));
vi.mock("./MediaPlayer", () => ({ default: () => <div>media player</div> }));
vi.mock("./TextViewer", () => ({ default: () => <div>text viewer</div> }));
vi.mock("./CsvViewer", () => ({ default: () => <div>csv viewer</div> }));
vi.mock("./PdfViewer", () => ({ default: () => <div>pdf viewer</div> }));
vi.mock("./DocxViewer", () => ({ default: () => <div>docx viewer</div> }));
vi.mock("./XlsxViewer", () => ({ default: () => <div>xlsx viewer</div> }));
vi.mock("./Unsupported", () => ({ default: ({ path }: { path: string }) => <div>unsupported {path}</div> }));

describe("the viewer picked for a file", () => {
  const cases: [string, string][] = [
    ["a/photo.PNG", "image viewer"],
    ["a/song.mp3", "media player"],
    ["a/clip.mp4", "media player"],
    ["a/notes.txt", "text viewer"],
    ["a/sales.csv", "csv viewer"],
    ["a/report.pdf", "pdf viewer"],
    ["a/letter.docx", "docx viewer"],
    ["a/budget.xlsx", "xlsx viewer"],
  ];

  it.each(cases)("%s opens in the %s", async (path, label) => {
    render(<ViewerHost path={path} />);
    expect(await screen.findByText(label)).toBeTruthy();
  });

  it("offers Preview not available for a type with no viewer", async () => {
    render(<ViewerHost path="a/movie.mkv" />);
    expect(await screen.findByText("unsupported a/movie.mkv")).toBeTruthy();
  });

  it("matches what the backend says an fs_open result means: only 'viewer' results reach it", async () => {
    // The explorer calls `open_doc` for `action: "viewer"` only; a blocked name never gets here,
    // and a name this host does not know gets the Unsupported screen rather than a guess.
    render(<ViewerHost path="a/setup.exe" />);
    expect(await screen.findByText("unsupported a/setup.exe")).toBeTruthy();
  });
});

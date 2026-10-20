import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { call } from "../../lib/tauri";
import DocxViewer from "./DocxViewer";
import { DOCX_FRAME_CSP, DOCX_FRAME_SANDBOX, docxSrcdoc, sanitizeDocx } from "./docxFrame";

vi.mock("../../lib/tauri", () => ({ call: vi.fn(), isTauri: () => true }));

// The converter is replaced by one that returns hostile markup.
vi.mock("docx-preview", () => ({
  renderAsync: vi.fn(async (_data: ArrayBuffer, host: HTMLElement) => {
    host.innerHTML =
      '<style>p{color:red}</style><section class="docx"><p onclick="alert(1)">Hello <b>world</b></p>' +
      '<script>alert(1)</script><img src="data:image/png;base64,AAAA" onerror="alert(2)">' +
      '<iframe src="https://evil.example"></iframe><a href="javascript:alert(3)">x</a>' +
      '<link rel="stylesheet" href="https://evil.example/a.css"><form action="https://evil.example"><input></form></section>';
  }),
}));

beforeEach(() => {
  vi.mocked(call).mockReset();
  vi.mocked(call).mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );
});

describe("the sandboxed frame", () => {
  it("allows nothing: no scripts, no same-origin, no forms, no popups", () => {
    expect(DOCX_FRAME_SANDBOX).toBe("");
    for (const token of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation"]) {
      expect(DOCX_FRAME_SANDBOX).not.toContain(token);
    }
  });

  it("carries its own policy first in the document: nothing from the network", () => {
    const doc = docxSrcdoc("<p>hi</p>");
    expect(DOCX_FRAME_CSP).toContain("default-src 'none'");
    expect(DOCX_FRAME_CSP).toContain("img-src data: blob:");
    expect(DOCX_FRAME_CSP).toContain("style-src 'unsafe-inline'");
    expect(DOCX_FRAME_CSP).toContain("font-src data:");
    expect(doc.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<style>"));
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>hi</p>"));
  });

  it("is cleaned of scripts, handlers, frames, forms and remote styles", () => {
    const html = sanitizeDocx(
      '<style>p{color:red}</style><p onclick="alert(1)">a</p><script>alert(1)</script><iframe src="x"></iframe>' +
        '<a href="javascript:alert(1)">l</a><img src="data:image/png;base64,AAAA" onerror="alert(2)">' +
        '<link rel="stylesheet" href="https://evil.example/a.css"><form><input></form><object data="x"></object>',
    );
    for (const bad of ["<script", "onclick", "onerror", "<iframe", "javascript:", "<link", "<form", "<object", "<input"]) {
      expect(html).not.toContain(bad);
    }
    expect(html).toContain("<p>a</p>");
    expect(html).toContain("<style>p{color:red}</style>");
    expect(html).toContain("data:image/png;base64,AAAA");
  });
});

describe("the Word viewer", () => {
  it("shows the converted document in a frame with an empty sandbox", async () => {
    const { container } = render(<DocxViewer path="Docs/letter.docx" />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Hello");
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).not.toContain("<script");
    expect(srcdoc).not.toContain("onclick");
    expect(srcdoc).not.toContain("onerror");
    expect(srcdoc).not.toContain("evil.example");
    expect(vi.mocked(call)).toHaveBeenCalledWith("fs_office_check", { path: "Docs/letter.docx" });
    // The working container never stays in the page.
    expect(document.body.querySelector("div[style*='-100000px']")).toBeNull();
  });

  it("says so when the file is too large", async () => {
    vi.mocked(call).mockRejectedValue({ kind: "tooLarge" });
    render(<DocxViewer path="big.docx" />);
    expect(await screen.findByText("Too large to preview.")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("says Preview not available when the file cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    render(<DocxViewer path="locked.docx" />);
    expect(await screen.findByText("Preview not available.")).toBeTruthy();
  });
});

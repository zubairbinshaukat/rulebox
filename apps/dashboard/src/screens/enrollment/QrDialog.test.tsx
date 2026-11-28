import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { QrDialog } from "./QrDialog";
import { enrollText as s } from "./strings";

// The encoder is the real one unless a test makes the chunk fail.
const qr = vi.hoisted(() => ({ fail: false }));
vi.mock("../../lib/qr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/qr")>();
  return { ...actual, makeQr: (text: string, level?: "L" | "M" | "Q" | "H") => (qr.fail ? Promise.reject(new Error("chunk failed")) : actual.makeQr(text, level)) };
});

// The QR dialog of Add a PC (UI pass, enrollment plan 3.4): the code only, as a picture, gone with the dialog.

const CODE = `RBX1.${btoa("https://happy-animal-123.convex.cloud#0123456789ABCDEFGHJK").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

afterEach(() => {
  cleanup();
  qr.fail = false;
});

describe("QrDialog", () => {
  it("draws the code as an image with an accessible name, in a dialog with a title and a close button", async () => {
    render(<QrDialog open code={CODE} onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: s.qrTitle })).toBeTruthy();
    const image = await screen.findByRole("img", { name: s.qrLabel });
    expect(image.tagName.toLowerCase()).toBe("svg");
    expect(image.getAttribute("viewBox")).toBe("0 0 45 45"); // 37 modules + 4 quiet modules each side
    const path = image.querySelector("path")!;
    expect(path.getAttribute("d")!.length).toBeGreaterThan(300);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByText(s.qrHint)).toBeTruthy();
  });

  it("never puts the code in the page as text or as an attribute", async () => {
    render(<QrDialog open code={CODE} onClose={() => undefined} />);
    await screen.findByRole("img", { name: s.qrLabel });
    expect(document.body.textContent).not.toContain(CODE);
    expect(document.body.innerHTML).not.toContain(CODE);
    expect(document.body.innerHTML).not.toContain("convex.cloud");
  });

  it("renders nothing while closed, and Close, Escape and the button call onClose", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<QrDialog open={false} code={CODE} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<QrDialog open code={CODE} onClose={onClose} />);
    await screen.findByRole("img", { name: s.qrLabel });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closing unmounts the picture; opening again starts from nothing, never showing the earlier code's picture first", async () => {
    function Host({ code }: { code: string }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>again</button>
          <QrDialog open={open} code={code} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Host code={CODE} />);
    await screen.findByRole("img", { name: s.qrLabel });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "again" }));
    expect(screen.queryByRole("img")).toBeNull(); // not drawn yet: the encoder answers a moment later
    await screen.findByRole("img", { name: s.qrLabel });
  });

  it("says so, in plain words, when the picture cannot be made", async () => {
    qr.fail = true;
    render(<QrDialog open code={CODE} onClose={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toBe(s.qrFailed);
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeTruthy());
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Truncate } from "./Truncate";

/** jsdom has no layout: say how wide the text is and how wide its box is. */
function size(el: HTMLElement, scroll: number, client: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scroll });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: client });
}

/** The tooltip code is downloaded the first time a cut text is hovered or focused: let that finish. */
async function loaded() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

const tip = () => document.querySelector<HTMLElement>(".dash-truncate-tip");
const visible = () => tip() !== null && !tip()!.hidden;

afterEach(() => {
  vi.useRealTimers();
  fireEvent.keyDown(document, { key: "Escape" });
});

describe("Truncate", () => {
  it("shows the full text after 400 ms of hover, only when the text is really cut", async () => {
    vi.useFakeTimers();
    render(<Truncate full="owner@example.com">owner@exam…</Truncate>);
    const box = screen.getByText("owner@exam…");
    size(box, 300, 100);
    fireEvent.mouseEnter(box);
    await loaded();
    expect(visible()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(visible()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(visible()).toBe(true);
    expect(tip()!.textContent).toBe("owner@example.com");
    // Hidden from assistive tech: the full text is already in the page.
    expect(tip()!.getAttribute("aria-hidden")).toBe("true");
    fireEvent.mouseLeave(box);
    expect(visible()).toBe(false);
  });

  it("shows nothing for text that fits, and does not even download the tooltip code for it", async () => {
    vi.useFakeTimers();
    render(<Truncate>short</Truncate>);
    const box = screen.getByText("short");
    size(box, 50, 100);
    fireEvent.mouseEnter(box);
    await loaded();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(visible()).toBe(false);
  });

  it("leaving before the tooltip code has arrived shows nothing", async () => {
    vi.useFakeTimers();
    render(<Truncate full="full text">cut</Truncate>);
    const box = screen.getByText("cut");
    size(box, 300, 100);
    fireEvent.mouseEnter(box);
    fireEvent.mouseLeave(box);
    await loaded();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(visible()).toBe(false);
  });

  it("shows at once on focus, hides on blur and on Escape", async () => {
    render(
      <Truncate>
        <a href="/x">A long link</a>
      </Truncate>,
    );
    const box = screen.getByRole("link").parentElement!;
    size(box, 300, 100);
    fireEvent.focus(screen.getByRole("link"));
    await loaded();
    expect(visible()).toBe(true);
    expect(tip()!.textContent).toBe("A long link");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(visible()).toBe(false);
    fireEvent.focus(screen.getByRole("link"));
    await loaded();
    expect(visible()).toBe(true);
    fireEvent.blur(screen.getByRole("link"));
    expect(visible()).toBe(false);
  });

  it("measures clamped text by height (2 or 3 lines)", async () => {
    render(<Truncate lines={2}>a long summary that goes on</Truncate>);
    const box = screen.getByText("a long summary that goes on");
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 60 });
    Object.defineProperty(box, "clientHeight", { configurable: true, value: 40 });
    fireEvent.focus(box);
    await loaded();
    expect(visible()).toBe(true);
  });

  it("cut plain text is a tab stop, text that fits or holds a link is not; there is no title attribute", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
    try {
      render(
        <>
          <Truncate>plain cut text</Truncate>
          <Truncate>
            <a href="/x">link text</a>
          </Truncate>
        </>,
      );
      const plain = screen.getByText("plain cut text");
      expect(plain.tabIndex).toBe(0);
      expect(plain.hasAttribute("title")).toBe(false);
      expect(screen.getByRole("link").parentElement!.hasAttribute("tabindex")).toBe(false);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollWidth", original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });

  it("text that fits is never a tab stop", () => {
    render(<Truncate>fits</Truncate>);
    expect(screen.getByText("fits").hasAttribute("tabindex")).toBe(false);
  });

  it("applies the width cap and the line count to the box", () => {
    render(
      <Truncate maxWidth={280} lines={3}>
        capped
      </Truncate>,
    );
    const box = screen.getByText("capped");
    expect(box.style.maxWidth).toBe("280px");
    expect(box.style.getPropertyValue("--dash-lines")).toBe("3");
  });

  it("gives no tooltip on touch (no hover)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: none)" }));
    try {
      render(<Truncate>cut on a phone</Truncate>);
      const box = screen.getByText("cut on a phone");
      size(box, 300, 100);
      fireEvent.mouseEnter(box);
      await loaded();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(visible()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

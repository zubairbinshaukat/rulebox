import { render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { call } from "../../lib/tauri";
import { useTaskbarShape } from "./useTaskbarShape";

vi.mock("../../lib/tauri", () => ({
  call: vi.fn(async () => undefined),
  isTauri: () => true,
}));

const mockedCall = vi.mocked(call);

let refreshShape: (() => void) | null = null;

function Bar() {
  const bar = useRef<HTMLDivElement>(null);
  const refresh = useTaskbarShape(bar, "in");
  // What the taskbar does after React commits a change.
  useEffect(() => {
    refreshShape = refresh;
  }, [refresh]);
  return (
    <div ref={bar}>
      <div className="rb-dock" data-box="12,12,60,60" />
      <div />
      <div className="rb-dock" data-box="900,12,400,60" />
    </div>
  );
}

/** Like the taskbar: signed out the middle child is a plain placeholder that React turns into the pill in place. */
function SwappingBar({ signedIn }: { signedIn: boolean }) {
  const bar = useRef<HTMLDivElement>(null);
  useTaskbarShape(bar, signedIn ? "in" : "out");
  return (
    <div ref={bar}>
      {signedIn ? <div className="rb-dock" data-box="300,12,200,60" /> : <div />}
      <div className="rb-dock" data-box="900,12,400,60" />
    </div>
  );
}

/** Toast cards sit beside the bar, in the same window. */
function BarWithToast() {
  const bar = useRef<HTMLDivElement>(null);
  useTaskbarShape(bar, "in");
  return (
    <div>
      <div ref={bar}>
        <div className="rb-dock" data-box="12,300,60,60" />
      </div>
      <div className="rb-toast" data-box="600,200,360,80" />
    </div>
  );
}

let observed: (() => void) | null = null;
const watched: Element[] = [];

beforeEach(() => {
  mockedCall.mockReset();
  mockedCall.mockImplementation(async () => undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe(target: Element) {
        watched.push(target);
      }
      disconnect() {}
    },
  );
  // jsdom has no layout: each pill reports the box written on it.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [left, top, width, height] = (this.dataset.box ?? "0,0,0,0").split(",").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} };
  });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observed = null;
  refreshShape = null;
  watched.length = 0;
});

describe("taskbar shape", () => {
  it("reports each pill in physical pixels, and only the pills", async () => {
    render(<Bar />);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledTimes(1));
    expect(mockedCall).toHaveBeenCalledWith("taskbar_shape", {
      rects: [
        { x: 18, y: 18, width: 90, height: 90 },
        { x: 1350, y: 18, width: 600, height: 90 },
      ],
    });
  });

  it("includes the toast cards that sit beside the bar", async () => {
    render(<BarWithToast />);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledTimes(1));
    expect(mockedCall).toHaveBeenCalledWith("taskbar_shape", {
      rects: [
        { x: 18, y: 450, width: 90, height: 90 },
        { x: 900, y: 300, width: 540, height: 120 },
      ],
    });
  });

  it("sends a grown pill in the same tick as the resize, not a frame later", async () => {
    render(<Bar />);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledTimes(1));
    // The apps pill gets wider (an app opened).
    const pill = document.querySelectorAll<HTMLElement>(".rb-dock")[1]!;
    pill.dataset.box = "850,12,500,60";
    observed?.();
    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(mockedCall).toHaveBeenLastCalledWith("taskbar_shape", {
      rects: [
        { x: 18, y: 18, width: 90, height: 90 },
        { x: 1275, y: 18, width: 750, height: 90 },
      ],
    });
  });

  it("sends the shape when told a layout change was just committed, without waiting for an observer", async () => {
    render(<Bar />);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledTimes(1));
    document.querySelectorAll<HTMLElement>(".rb-dock")[1]!.dataset.box = "850,12,500,60";
    refreshShape?.();
    expect(mockedCall).toHaveBeenCalledTimes(2);
  });

  it("watches a pill that React made out of a placeholder in place (sign-in)", async () => {
    const { rerender } = render(<SwappingBar signedIn={false} />);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledTimes(1));
    expect(watched).toHaveLength(1);
    watched.length = 0;
    rerender(<SwappingBar signedIn />);
    // Both pills are observed again; the new one is among them.
    await waitFor(() => expect(watched).toHaveLength(2));
    expect(watched.some((el) => (el as HTMLElement).dataset.box === "300,12,200,60")).toBe(true);
  });

  it("does not repeat a shape that has not changed", async () => {
    render(<Bar />);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledTimes(1));
    observed?.();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });
});

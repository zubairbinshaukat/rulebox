import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEntry } from "@rulebox/types";

import { AppArt } from "./AppArtIcon";
import { useIconArt, type IconArt } from "./iconArt";

vi.mock("./iconArt", () => ({ useIconArt: vi.fn() }));

function app(extra: Partial<AppEntry> = {}): AppEntry {
  return {
    id: "zubyr-web",
    name: "Zubyr",
    description: null,
    kind: { type: "web", url: "https://zubyr.dev", allowedDomains: ["zubyr.dev"], permissions: {} as never },
    iconKey: null,
    iconUrl: null,
    hue: 175,
    pinnedTaskbar: true,
    pinnedDesktop: true,
    badge: null,
    ...extra,
  } as AppEntry;
}

const withIcon = { iconUrl: "http://rbicon.localhost/app:00ff" };

function art(value: IconArt | undefined) {
  vi.mocked(useIconArt).mockReturnValue(value);
}

describe("AppArt (taskbar button, app switcher, Start menu)", () => {
  beforeEach(() => art(undefined));

  it("shows the app's own icon full-bleed in the rounded box, with no plate or ring of its own", () => {
    art({ kind: "keyed", tone: "dark", edge: "rgb(242 240 230)", mask: "blob:x" });
    const { container } = render(<AppArt app={app(withIcon)} />);
    const box = container.querySelector<HTMLElement>(".rb-task__art--photo");
    expect(box?.getAttribute("data-icon-kind")).toBe("keyed");
    // The icon's own background colour sits behind the image, so no other colour fringes the rim.
    expect(box?.style.getPropertyValue("--rb-icon-edge")).toBe("rgb(242 240 230)");
    const image = box?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("http://rbicon.localhost/app:00ff");
    // The window-icon plate (white, with a border) is not used for a catalogue icon.
    expect(container.querySelector(".rb-task__art--image")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws the logo's cut-out, not the padded original, when the icon was cut out", () => {
    art({ kind: "keyed", tone: "dark", edge: "rgb(242 240 230)", mask: "blob:m", cutout: "blob:cut" });
    const { container } = render(<AppArt app={app(withIcon)} />);
    const box = container.querySelector<HTMLElement>(".rb-task__art--photo");
    expect(box?.getAttribute("data-icon-fit")).toBe("logo");
    expect(box?.querySelector("img")?.getAttribute("src")).toBe("blob:cut");
    // The icon's old background colour is not drawn: no plate colour is handed to the box at all.
    expect(box?.style.getPropertyValue("--rb-icon-edge")).toBe("");
    expect(box?.getAttribute("data-icon-recolor")).toBeNull();
  });

  it("asks to recolour (never box) only a logo that vanishes on a theme (the black Z on dark)", () => {
    art({ kind: "keyed", tone: "dark", edge: "rgb(242 240 230)", cutout: "blob:cut", recolor: "dark-logo" });
    const { container } = render(<AppArt app={app(withIcon)} />);
    expect(container.querySelector(".rb-task__art--photo")?.getAttribute("data-icon-recolor")).toBe("dark-logo");
  });

  it("uses the same cut-out in the switcher and the Start menu sizes", () => {
    art({ kind: "keyed", tone: "dark", edge: "rgb(239 236 254)", cutout: "blob:cut" });
    const large = render(<AppArt app={app(withIcon)} large />);
    expect(large.container.querySelector(".rb-task__art--lg img")?.getAttribute("src")).toBe("blob:cut");
    large.unmount();
    const small = render(<AppArt app={app(withIcon)} small />);
    expect(small.container.querySelector(".rb-task__art--sm img")?.getAttribute("src")).toBe("blob:cut");
  });

  it("keeps the original and `cover` for a picture that cannot be cut out", () => {
    art({ kind: "opaque", tone: "dark" });
    const { container } = render(<AppArt app={app(withIcon)} />);
    const box = container.querySelector(".rb-task__art--photo");
    expect(box?.getAttribute("data-icon-fit")).toBe("cover");
    expect(box?.querySelector("img")?.getAttribute("src")).toBe(withIcon.iconUrl);
  });

  it("puts a transparent logo on a plate chosen by its tone", () => {
    art({ kind: "transparent", tone: "light", cutout: "blob:cut" });
    const { container } = render(<AppArt app={app(withIcon)} />);
    const box = container.querySelector(".rb-task__art--photo");
    expect(box?.getAttribute("data-icon-kind")).toBe("transparent");
    expect(box?.getAttribute("data-icon-tone")).toBe("light");
    expect(box?.getAttribute("data-icon-fit")).toBe("logo");
  });

  it("insets a transparent logo whose cut-out failed, so it still has a margin on its plate", () => {
    art({ kind: "transparent", tone: "dark" });
    const { container } = render(<AppArt app={app(withIcon)} />);
    expect(container.querySelector(".rb-task__art--photo")?.getAttribute("data-icon-fit")).toBe("inset");
  });

  it("waits for the analysis before it shows the image (no flash of the wrong look)", () => {
    const { container } = render(<AppArt app={app(withIcon)} />);
    expect(container.querySelector(".rb-task__art--photo")?.getAttribute("data-icon-kind")).toBe("pending");
  });

  it("has a switcher size and a Start menu size", () => {
    const large = render(<AppArt app={app(withIcon)} large />);
    expect(large.container.querySelector(".rb-task__art--photo.rb-task__art--lg")).not.toBeNull();
    large.unmount();
    const small = render(<AppArt app={app(withIcon)} small />);
    expect(small.container.querySelector(".rb-task__art--photo.rb-task__art--sm")).not.toBeNull();
  });

  it("falls back to the glyph on the app's colour without one", () => {
    const { container } = render(<AppArt app={app()} large />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".rb-task__art--glyph.rb-task__art--lg svg")).not.toBeNull();
  });
});

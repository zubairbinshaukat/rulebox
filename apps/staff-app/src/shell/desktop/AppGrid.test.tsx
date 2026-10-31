import { render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEntry } from "@rulebox/types";

import { expectNoAxeViolations } from "../../test/axe";
import { useIconArt, type IconArt } from "../iconArt";
import { AppGrid } from "./AppGrid";

vi.mock("../../lib/tauri", () => ({ call: vi.fn(async () => undefined), isTauri: () => true, anchorOf: () => null }));
vi.mock("../iconArt", () => ({ useIconArt: vi.fn() }));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  }
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  vi.unstubAllGlobals();
});

function app(id: string, name: string, iconUrl: string | null): AppEntry {
  return {
    id,
    name,
    description: null,
    kind: { type: "web", url: "https://example.test", allowedDomains: [], permissions: {} as never },
    iconKey: null,
    iconUrl,
    hue: 175,
    pinnedTaskbar: false,
    pinnedDesktop: true,
    badge: null,
  };
}

/** The analysis each icon URL gets (the real one needs a canvas, which jsdom has not). */
const arts: Record<string, IconArt | undefined> = {};

beforeEach(() => {
  for (const key of Object.keys(arts)) delete arts[key];
  vi.mocked(useIconArt).mockImplementation((url) => (url ? arts[url] : undefined));
});

function tileOf(name: string) {
  return within(screen.getByRole("list", { name: "Apps" })).getByRole("button", { name: new RegExp(name) });
}

describe("AppGrid icons", () => {
  it("draws a keyed icon full-bleed and its watermark as the logo silhouette, never as the icon image", async () => {
    arts["http://rbicon.localhost/app:z"] = { kind: "keyed", tone: "dark", edge: "rgb(242 240 230)", mask: "blob:z-mask" };
    const { container } = render(
      <AppGrid apps={[app("z", "Zubyr", "http://rbicon.localhost/app:z")]} status="ready" />,
    );
    const tile = tileOf("Zubyr");
    // One <img> in the whole tile: the small icon. The corner copy is a mask, not the picture.
    expect(tile.querySelectorAll("img")).toHaveLength(1);
    expect(tile.querySelector(".rb-tile__icon .rb-tile__img")).not.toBeNull();
    expect(tile.querySelector(".rb-tile__clip img")).toBeNull();
    const mark = tile.querySelector<HTMLElement>(".rb-tile__clip .rb-tile__mark--mask");
    expect(mark?.style.getPropertyValue("--rb-mark-url")).toBe('url("blob:z-mask")');
    const icon = tile.querySelector<HTMLElement>(".rb-tile__icon--image");
    expect(icon?.getAttribute("data-icon-kind")).toBe("keyed");
    expect(icon?.style.getPropertyValue("--rb-icon-edge")).toBe("rgb(242 240 230)");
    await expectNoAxeViolations(container);
  });

  it("draws the tile's small icon from the logo's cut-out, with no plate in the icon's old colour", () => {
    arts["http://rbicon.localhost/app:c"] = {
      kind: "keyed",
      tone: "dark",
      edge: "rgb(239 236 254)",
      mask: "blob:c-mask",
      cutout: "blob:c-cut",
    };
    render(<AppGrid apps={[app("c", "Batwa", "http://rbicon.localhost/app:c")]} status="ready" />);
    const tile = tileOf("Batwa");
    const icon = tile.querySelector<HTMLElement>(".rb-tile__icon--image");
    expect(icon?.getAttribute("data-icon-fit")).toBe("logo");
    expect(icon?.style.getPropertyValue("--rb-icon-edge")).toBe("");
    expect(icon?.getAttribute("data-icon-recolor")).toBeNull();
    expect(tile.querySelector(".rb-tile__icon .rb-tile__img")?.getAttribute("src")).toBe("blob:c-cut");
    // The big watermark stays the silhouette mask, never the cut-out.
    expect(tile.querySelector<HTMLElement>(".rb-tile__mark--mask")?.style.getPropertyValue("--rb-mark-url")).toBe(
      'url("blob:c-mask")',
    );
    expect(tile.querySelectorAll("img")).toHaveLength(1);
  });

  it("hands a dark logo's recolour request to the tile", () => {
    arts["http://rbicon.localhost/app:d"] = { kind: "keyed", tone: "dark", edge: "rgb(1 2 3)", cutout: "blob:d", recolor: "dark-logo" };
    render(<AppGrid apps={[app("d", "Darkish", "http://rbicon.localhost/app:d")]} status="ready" />);
    expect(tileOf("Darkish").querySelector(".rb-tile__icon--image")?.getAttribute("data-icon-recolor")).toBe("dark-logo");
  });

  it("keeps `cover` for a keyed icon without a cut-out, and insets a transparent one", () => {
    arts["http://rbicon.localhost/app:k"] = { kind: "keyed", tone: "dark", edge: "rgb(1 2 3)" };
    arts["http://rbicon.localhost/app:i"] = { kind: "transparent", tone: "dark" };
    render(
      <AppGrid
        apps={[app("k", "Keyed", "http://rbicon.localhost/app:k"), app("i", "Inset", "http://rbicon.localhost/app:i")]}
        status="ready"
      />,
    );
    expect(tileOf("Keyed").querySelector(".rb-tile__icon--image")?.getAttribute("data-icon-fit")).toBe("cover");
    expect(tileOf("Inset").querySelector(".rb-tile__icon--image")?.getAttribute("data-icon-fit")).toBe("inset");
    expect(tileOf("Keyed").querySelector(".rb-tile__img")?.getAttribute("src")).toBe("http://rbicon.localhost/app:k");
  });

  it("gives a transparent logo a plate by tone and its own silhouette", () => {
    arts["http://rbicon.localhost/app:t"] = { kind: "transparent", tone: "light", mask: "blob:t-mask" };
    render(<AppGrid apps={[app("t", "Zahras POS", "http://rbicon.localhost/app:t")]} status="ready" />);
    const icon = tileOf("Zahras POS").querySelector(".rb-tile__icon--image");
    expect(icon?.getAttribute("data-icon-kind")).toBe("transparent");
    expect(icon?.getAttribute("data-icon-tone")).toBe("light");
    expect(tileOf("Zahras POS").querySelector(".rb-tile__mark--mask")).not.toBeNull();
  });

  it("falls back to the app's glyph for the corner when the icon has no silhouette", () => {
    arts["http://rbicon.localhost/app:p"] = { kind: "opaque", tone: "dark" };
    render(<AppGrid apps={[app("p", "Photo app", "http://rbicon.localhost/app:p")]} status="ready" />);
    const tile = tileOf("Photo app");
    expect(tile.querySelector(".rb-tile__mark--mask")).toBeNull();
    expect(tile.querySelector(".rb-tile__clip .rb-tile__mark--glyph svg")).not.toBeNull();
    expect(tile.querySelector(".rb-tile__clip img")).toBeNull();
  });

  it("shows no corner copy and no image until the analysis is known", () => {
    render(<AppGrid apps={[app("w", "Waiting", "http://rbicon.localhost/app:w")]} status="ready" />);
    const tile = tileOf("Waiting");
    expect(tile.querySelector(".rb-tile__clip .rb-tile__mark")).toBeNull();
    expect(tile.querySelector(".rb-tile__icon--image")?.getAttribute("data-icon-kind")).toBe("pending");
  });

  it("an app without an icon keeps its glyph tile", () => {
    render(<AppGrid apps={[app("g", "Glyphy", null)]} status="ready" />);
    const tile = tileOf("Glyphy");
    expect(tile.querySelector(".rb-tile__icon--glyph svg")).not.toBeNull();
    expect(tile.querySelector("img")).toBeNull();
  });
});

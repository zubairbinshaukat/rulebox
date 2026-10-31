import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../test/axe";
import source from "../../src-tauri/src/webapp/bar.js?raw";

/**
 * The bar above every web app's site (plan 7.10, Step 15). The page runs in its own small WebView2;
 * here it runs in jsdom with a stand-in for `window` and for WebView2's message bridge.
 */

interface FakeWindow extends EventTarget {
  chrome?: { webview?: Bridge };
  matchMedia: (query: string) => { matches: boolean };
  innerWidth: number;
}

interface Bridge extends EventTarget {
  postMessage: ReturnType<typeof vi.fn>;
}

interface Booted {
  win: FakeWindow;
  bridge: Bridge;
  /** Everything the page has sent to the host, oldest first. */
  sent: () => Array<Record<string, unknown>>;
  send: (message: unknown) => void;
  button: (name: string) => HTMLButtonElement;
  bar: HTMLElement;
  address: HTMLElement;
}

function boot(options: { width?: number; systemDark?: boolean; noBridge?: boolean } = {}): Booted {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  const bridge = Object.assign(new EventTarget(), { postMessage: vi.fn() }) as Bridge;
  const win = new EventTarget() as FakeWindow;
  Object.assign(win, {
    innerWidth: options.width ?? 1000,
    matchMedia: () => ({ matches: options.systemDark ?? false }),
  });
  if (!options.noBridge) win.chrome = { webview: bridge };
  new Function("window", source)(win);

  const find = (selector: string): HTMLElement => {
    const found = document.body.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found;
  };
  return {
    win,
    bridge,
    sent: () => bridge.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>),
    send: (message) => bridge.dispatchEvent(Object.assign(new Event("message"), { data: message })),
    button: (name) => find(`button[data-action="${name}"]`) as HTMLButtonElement,
    bar: find(".bar"),
    address: find(".address"),
  };
}

const state = (over: Record<string, unknown> = {}) => ({
  rbBar: 1,
  back: false,
  forward: false,
  loading: false,
  theme: "light",
  calm: false,
  address: { kind: "app", secure: false, host: "Orders", rest: "", title: "Orders" },
  actions: [],
  ...over,
});

const site = (over: Record<string, unknown> = {}) => ({
  kind: "site",
  secure: true,
  host: "portal.example.com",
  rest: "/orders/17?tab=lines",
  title: "https://portal.example.com/orders/17?tab=lines",
  ...over,
});

const actions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `act-${i}`, label: `Action ${i}`, icon: i % 2 ? "star" : "info" }));

/** A click like a mouse makes it (`detail` 1); `button.click()` is the keyboard kind (`detail` 0). */
const mouseClick = (node: Element) => node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("the bar's layout", () => {
  it("is a toolbar of Back, Forward and Reload, then a read-only address, then an action slot", () => {
    const page = boot();
    expect(page.bar.getAttribute("role")).toBe("toolbar");
    expect(page.bar.getAttribute("aria-label")).toBe("Page navigation");
    const children = [...page.bar.children].map((child) => child.className);
    expect(children).toEqual(["nav", "address", "actions"]);
    expect(page.button("back").getAttribute("aria-label")).toBe("Back");
    expect(page.button("forward").getAttribute("aria-label")).toBe("Forward");
    expect(page.button("reload").getAttribute("aria-label")).toBe("Reload");
    expect(page.button("back").disabled).toBe(true);
    expect(page.button("forward").disabled).toBe(true);
    expect(page.button("reload").disabled).toBe(false);
  });

  it("has no input of any kind: no way to type, edit, select or submit an address", () => {
    const page = boot();
    page.send(state({ address: site() }));
    expect(document.body.querySelectorAll("input, textarea, select, form, a, [contenteditable]")).toHaveLength(0);
    expect(page.address.tagName).toBe("DIV");
    expect(page.address.hasAttribute("tabindex")).toBe(false);
    expect(page.address.getAttribute("role")).toBe("group");
    expect(page.address.getAttribute("aria-label")).toBe("Address (read only)");
  });

  it("does nothing, and does not throw, without the WebView2 bridge", () => {
    expect(() => boot({ noBridge: true })).not.toThrow();
  });

  it("tells the host it is listening once, after it can hear", () => {
    const page = boot();
    expect(page.sent()).toEqual([{ t: "ready", rbBar: 1 }]);
  });
});

describe("the buttons", () => {
  it("follow what the host says and no more", () => {
    const page = boot();
    page.send(state({ back: true }));
    expect(page.button("back").disabled).toBe(false);
    expect(page.button("forward").disabled).toBe(true);
    page.send(state({ back: true, forward: true }));
    expect(page.button("forward").disabled).toBe(false);
    page.send(state());
    expect(page.button("back").disabled).toBe(true);
    expect(page.button("forward").disabled).toBe(true);
  });

  it("ignore messages that are not the host's, and treat anything but true as false", () => {
    const page = boot();
    page.send(state({ back: true }));
    page.send({ back: false });
    page.send("rbBar");
    page.send(null);
    page.send({ rbBar: 2, back: false });
    expect(page.button("back").disabled).toBe(false);
    page.send(state({ back: "true", forward: 1, loading: "yes" }));
    expect(page.button("back").disabled).toBe(true);
    expect(page.button("forward").disabled).toBe(true);
    expect(page.button("reload").getAttribute("aria-label")).toBe("Reload");
  });

  it("ask the host to go back, forward or reload, and only when enabled", () => {
    const page = boot();
    page.button("back").click();
    page.button("forward").click();
    expect(page.sent().filter((m) => m["t"] === "nav")).toEqual([]);

    page.send(state({ back: true, forward: true }));
    page.button("back").click();
    mouseClick(page.button("forward"));
    page.button("reload").click();
    expect(page.sent().filter((m) => m["t"] === "nav")).toEqual([
      { rbBar: 1, t: "nav", a: "back", by: "key" },
      { rbBar: 1, t: "nav", a: "forward", by: "mouse" },
      { rbBar: 1, t: "nav", a: "reload", by: "key" },
    ]);
  });

  it("make Reload the Stop button while a page loads", () => {
    const page = boot();
    page.send(state({ loading: true }));
    const reload = page.button("reload");
    expect(reload.getAttribute("aria-label")).toBe("Stop");
    expect(reload.title).toBe("Stop");
    expect(reload.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(page.bar.classList.contains("loading")).toBe(true);
    reload.click();
    expect(page.sent().at(-1)).toEqual({ rbBar: 1, t: "nav", a: "stop", by: "key" });

    page.send(state());
    expect(reload.getAttribute("aria-label")).toBe("Reload");
    expect(reload.getAttribute("aria-keyshortcuts")).toBe("F5");
    expect(page.bar.classList.contains("loading")).toBe(false);
  });

  it("offer the shortcuts in their tooltips and aria-keyshortcuts", () => {
    const page = boot();
    expect(page.button("back").getAttribute("aria-keyshortcuts")).toBe("Alt+Left");
    expect(page.button("forward").getAttribute("aria-keyshortcuts")).toBe("Alt+Right");
    expect(page.button("reload").getAttribute("aria-keyshortcuts")).toBe("F5");
    expect(page.button("back").title).toBe("Back (Alt+Left)");
    expect(page.button("reload").title).toBe("Reload (F5)");
  });

  it("draw linear glyphs that are decorative, with the button carrying the name", () => {
    const page = boot();
    for (const name of ["back", "forward", "reload"]) {
      expect(page.button(name).querySelectorAll("path").length, name).toBeGreaterThan(0);
    }
    // Reload holds two glyphs (refresh, and close for Stop); the style swaps them.
    expect(page.button("reload").querySelectorAll("svg")).toHaveLength(2);
    for (const svg of document.body.querySelectorAll("svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    }
  });
});

describe("the address", () => {
  it("shows the lock, the host prominently and the rest dimmer, with the full address as the tooltip", () => {
    const page = boot();
    page.send(state({ address: site() }));
    expect(page.address.getAttribute("data-kind")).toBe("site");
    expect(page.address.getAttribute("data-secure")).toBe("true");
    expect(page.address.getAttribute("title")).toBe("https://portal.example.com/orders/17?tab=lines");
    expect(page.address.querySelector(".host")?.textContent).toBe("portal.example.com");
    expect(page.address.querySelector(".rest")?.textContent).toBe("/orders/17?tab=lines");
  });

  it("marks an address that is not https, and shows the app name for the start and blocked pages", () => {
    const page = boot();
    page.send(state({ address: site({ secure: false }) }));
    expect(page.address.getAttribute("data-secure")).toBe("false");

    page.send(state({ address: { kind: "blocked", secure: false, host: "Orders", rest: "", title: "Orders: that site is not allowed" } }));
    expect(page.address.getAttribute("data-kind")).toBe("blocked");
    expect(page.address.querySelector(".host")?.textContent).toBe("Orders");
    expect(page.address.querySelector(".rest")?.textContent).toBe("");

    page.send(state());
    expect(page.address.getAttribute("data-kind")).toBe("app");
    expect(page.address.querySelector(".host")?.textContent).toBe("Orders");
  });

  it("draws what it is given as text, never as markup", () => {
    const page = boot();
    page.send(state({ address: site({ host: '<img src=x onerror="alert(1)">', rest: "<b>x</b>", title: '"><script>' }) }));
    expect(page.address.querySelector("img, b, script")).toBeNull();
    expect(page.address.querySelector(".host")?.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("falls back to a plain app address for anything odd", () => {
    const page = boot();
    page.send(state({ address: { kind: "weird", secure: "yes", host: 5, rest: null } }));
    expect(page.address.getAttribute("data-kind")).toBe("app");
    expect(page.address.getAttribute("data-secure")).toBe("false");
    expect(page.address.querySelector(".host")?.textContent).toBe("");
    page.send(state({ address: undefined }));
    expect(page.address.getAttribute("data-kind")).toBe("app");
  });
});

describe("the action slot", () => {
  it("is empty and takes no room when the host sends no actions", () => {
    const page = boot();
    page.send(state());
    const slot = document.body.querySelector<HTMLElement>(".actions")!;
    expect(slot.hasAttribute("hidden")).toBe(true);
    expect(slot.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows each action as an icon button with a tooltip and an accessible name, and reports the click", () => {
    const page = boot();
    page.send(state({ actions: actions(2) }));
    const slot = document.body.querySelector<HTMLElement>(".actions")!;
    expect(slot.hasAttribute("hidden")).toBe(false);
    const buttons = [...slot.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Action 0", "Action 1"]);
    expect(buttons.map((b) => b.title)).toEqual(["Action 0", "Action 1"]);
    mouseClick(buttons[1]!);
    expect(page.sent().at(-1)).toEqual({ rbBar: 1, t: "action", id: "act-1", by: "mouse" });
  });

  it("ignores actions that are not well formed, and draws an unknown icon as info", () => {
    const page = boot();
    page.send(state({ actions: [{ id: "a", label: "A", icon: "no-such-icon" }, { label: "no id" }, null, 7] }));
    const buttons = document.body.querySelectorAll(".actions button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.innerHTML).toContain("<circle");
  });

  it("puts what does not fit into a More menu, which grows the bar while it is open", () => {
    const page = boot({ width: 1000 });
    page.send(state({ actions: actions(6) }));
    const slot = document.body.querySelector<HTMLElement>(".actions")!;
    // Four fit at this width: three actions and More.
    expect(slot.querySelectorAll("button")).toHaveLength(4);
    const more = slot.querySelector<HTMLButtonElement>("[data-more]")!;
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    const menu = document.body.querySelector<HTMLElement>(".menu")!;
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(menu.hasAttribute("hidden")).toBe(true);

    mouseClick(more);
    expect(page.sent().at(-1)).toEqual({ rbBar: 1, t: "menu", open: true });
    expect(menu.hasAttribute("hidden")).toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");

    mouseClick(menu.querySelectorAll("button")[1]!);
    expect(page.sent().slice(-2)).toEqual([
      { rbBar: 1, t: "menu", open: false },
      { rbBar: 1, t: "action", id: "act-4", by: "mouse" },
    ]);
    expect(menu.hasAttribute("hidden")).toBe(true);
  });

  it("closes the menu with Escape or a click outside, and says so", () => {
    const page = boot();
    page.send(state({ actions: actions(6) }));
    const more = document.body.querySelector<HTMLButtonElement>("[data-more]")!;
    mouseClick(more);
    document.body.querySelector(".menu button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(page.sent().at(-1)).toEqual({ rbBar: 1, t: "menu", open: false });
    mouseClick(more);
    mouseClick(document.body.querySelector(".scrim")!);
    expect(page.sent().at(-1)).toEqual({ rbBar: 1, t: "menu", open: false });
    expect(page.sent().filter((m) => m["t"] === "menu")).toHaveLength(4);
  });

  it("shows fewer actions in a narrower window", () => {
    expect(boot({ width: 400 }).win.innerWidth).toBe(400);
    const narrow = boot({ width: 400 });
    narrow.send(state({ actions: actions(3) }));
    // One slot: that is More, and everything is in its menu.
    expect(document.body.querySelectorAll(".actions > button")).toHaveLength(1);
    expect(document.body.querySelectorAll(".menu button")).toHaveLength(3);
  });
});

describe("the keyboard", () => {
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  };

  it("is one tab stop: the toolbar remembers the button used last", () => {
    boot();
    const stops = [...document.body.querySelectorAll(".bar button")].filter((b) => b.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("data-action")).toBe("reload");
  });

  it("moves with the arrow keys, Home and End over the enabled buttons only", () => {
    const page = boot();
    page.send(state({ back: true }));
    page.button("back").focus();
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement, "Forward is disabled and skipped").toBe(page.button("reload"));
    press("ArrowRight");
    expect(document.activeElement, "it wraps").toBe(page.button("back"));
    press("ArrowLeft");
    expect(document.activeElement).toBe(page.button("reload"));
    press("Home");
    expect(document.activeElement).toBe(page.button("back"));
    press("End");
    expect(document.activeElement).toBe(page.button("reload"));
    expect(page.button("reload").getAttribute("tabindex")).toBe("0");
    expect(page.button("back").getAttribute("tabindex")).toBe("-1");
  });

  it("gives the focus back to the page on Escape and leaves other keys alone", () => {
    const page = boot();
    page.button("reload").focus();
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(page.sent().at(-1)).toEqual({ rbBar: 1, t: "focus-page" });
    expect(press("a").defaultPrevented).toBe(false);
    expect(press("ArrowRight", { altKey: true }).defaultPrevented).toBe(false);
  });
});

describe("look", () => {
  it("follows the employee's theme and falls back to the system for auto", () => {
    const page = boot();
    const theme = () => document.documentElement.getAttribute("data-theme");
    page.send(state({ theme: "light" }));
    expect(theme()).toBe("light");
    page.send(state({ theme: "dark" }));
    expect(theme()).toBe("dark");
    page.send(state({ theme: "auto" }));
    expect(theme()).toBe("light");
    const system = boot({ systemDark: true });
    system.send(state({ theme: "auto" }));
    expect(theme()).toBe("dark");
    system.send(state({ theme: "nonsense" }));
    expect(theme()).toBe("dark");
  });

  it("turns motion off in Lite mode", () => {
    const page = boot();
    page.send(state({ calm: true }));
    expect(page.bar.classList.contains("calm")).toBe(true);
    page.send(state({ calm: false }));
    expect(page.bar.classList.contains("calm")).toBe(false);
  });
});

describe("accessibility", () => {
  it("has no axe violations: empty, with an address, loading, dark, with actions and a menu", async () => {
    const page = boot();
    await expectNoAxeViolations(document.body);
    page.send(state({ back: true, forward: true, address: site() }));
    await expectNoAxeViolations(document.body);
    page.send(state({ back: true, loading: true, theme: "dark", calm: true, address: site({ secure: false }) }));
    await expectNoAxeViolations(document.body);
    page.send(state({ actions: actions(6) }));
    await expectNoAxeViolations(document.body);
    mouseClick(document.body.querySelector("[data-more]")!);
    await expectNoAxeViolations(document.body);
  });
});
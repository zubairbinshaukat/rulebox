import { afterEach, beforeEach, describe, expect, it } from "vitest";
import source from "./boot.js?raw";

const MAP = {
  f: ["/assets/SignIn-1.js", "/assets/Auth-2.js", "/assets/Layout-3.js", "/assets/Devices-4.js", "/assets/DeviceDetail-5.js"],
  r: { "/sign-in": [0, 1], "/devices": [2, 3], "/devices/:": [2, 4] },
  p: ["/sign-in"],
};

/** Runs the boot script as the browser would, with the build's route map (or none, as in dev). */
function boot(path: string, withMap = true) {
  window.history.replaceState(null, "", path);
  const code = withMap ? source.replace("/*RB_ROUTES*/ null", JSON.stringify(MAP)) : source;
  new Function(code)();
}

const preloads = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map((l) => l.getAttribute("href"));

describe("boot.js", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.head.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("applies the saved theme before the first paint", () => {
    localStorage.setItem("rulebox.theme", "dark");
    boot("/sign-in", false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(preloads()).toEqual([]);
  });

  it("follows the system when nothing valid is saved, and adds nothing for light", () => {
    localStorage.setItem("rulebox.theme", "purple");
    boot("/sign-in", false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("auto");
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("rulebox.theme", "light");
    boot("/sign-in", false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("preloads the chunks of the URL's screen", () => {
    boot("/sign-in");
    expect(preloads()).toEqual(["/assets/SignIn-1.js", "/assets/Auth-2.js"]);
  });

  it("matches ids, but preloads sign-in for a member screen without a session", () => {
    boot("/devices/k57");
    expect(preloads()).toEqual(["/assets/SignIn-1.js", "/assets/Auth-2.js"]);
  });

  it("preloads the member screen when a Convex Auth session is stored", () => {
    localStorage.setItem("__convexAuthRefreshToken_https://x.convex.cloud", "t");
    boot("/devices/k57/");
    expect(preloads()).toEqual(["/assets/Layout-3.js", "/assets/DeviceDetail-5.js"]);
  });

  it("does nothing for an unknown path", () => {
    boot("/nope/a/b");
    expect(preloads()).toEqual([]);
  });
});

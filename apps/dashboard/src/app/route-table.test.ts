import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import { ROUTE_SCREENS, SCREEN_FILES, SESSIONLESS_PATHS, routeKey, screensForPath } from "./route-table";

const sources = Object.keys(import.meta.glob("/src/**/*.tsx"));

describe("route table", () => {
  it("points at files that exist", () => {
    for (const file of Object.values(SCREEN_FILES)) expect(sources, file).toContain(`/${file}`);
  });

  it("covers every route of App.tsx", () => {
    const paths = [...app.matchAll(/<Route (?:index|path="([^"]+)")/g)].map((m) => {
      const p = m[1] ?? "";
      return p.startsWith("/") ? p : `/${p}`;
    });
    for (const p of paths) {
      if (p === "/*" || p === "/gallery") continue; // not preloaded on purpose
      expect(routeKey(p.replace(/:id$/, "some-id")), p).not.toBeNull();
    }
  });

  it("maps ids and trailing slashes to the right screens", () => {
    expect(screensForPath("/")).toEqual(["Layout", "Overview"]);
    expect(screensForPath("/devices/")).toEqual(["Layout", "Devices"]);
    expect(screensForPath("/devices/k57abc")).toEqual(["Layout", "DeviceDetail"]);
    expect(screensForPath("/apps/new")).toEqual(["Layout", "AppEdit"]);
    expect(screensForPath("/devices/a/b")).toEqual([]);
    expect(screensForPath("/gallery")).toEqual([]);
  });

  it("lists only screens that exist, and no session-less path needs the shell", () => {
    for (const screens of Object.values(ROUTE_SCREENS)) for (const s of screens) expect(SCREEN_FILES[s]).toBeTruthy();
    for (const p of SESSIONLESS_PATHS) expect(ROUTE_SCREENS[p]).not.toContain("Layout");
  });
});

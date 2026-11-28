import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_PERMISSIONS } from "../../../data/types";
import * as v from "../../../lib/validate";
import { HUES } from "../appForm";
import { GALLERY, GALLERY_CATEGORIES, galleryApp, galleryIn, searchGallery } from "./catalog";

// The logo files of the gallery (none in v1: letter tiles, decision D2). `?raw` gives an SVG's text, so its size can be checked.
const svgLogos = import.meta.glob("./logos/*.svg", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const otherLogos = import.meta.glob("./logos/*.webp", { query: "?url", import: "default", eager: true }) as Record<string, string>;

describe("the popular apps gallery", () => {
  it("has 16 to 24 entries with unique, URL-safe keys and names", () => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(16);
    expect(GALLERY.length).toBeLessThanOrEqual(24);
    const keys = GALLERY.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(GALLERY.map((a) => a.name)).size).toBe(GALLERY.length);
    for (const key of keys) expect(key, key).toMatch(/^[a-z0-9]+$/);
  });

  it("uses valid categories, tile hues and short blurbs", () => {
    for (const app of GALLERY) {
      expect(GALLERY_CATEGORIES, app.key).toContain(app.category);
      expect(HUES, app.key).toContain(app.hue);
      const words = app.blurb.split(/\s+/).length;
      expect(words, `${app.key}: "${app.blurb}"`).toBeGreaterThanOrEqual(2);
      expect(words, `${app.key}: "${app.blurb}"`).toBeLessThanOrEqual(6);
      expect(v.name(app.name, v.NAME_MAX.app), app.key).toBeNull();
    }
    for (const category of GALLERY_CATEGORIES) expect(galleryIn(category).length, category).toBeGreaterThan(0);
  });

  it("every Windows entry has a valid program path, and a winget id unless it ships with Windows", () => {
    for (const app of GALLERY.filter((a) => a.kind === "desktop")) {
      expect(app.exe, app.key).toBeDefined();
      expect(v.exePath(app.exe!, false), `${app.key}: ${app.exe}`).toBeNull();
      expect(app.url, app.key).toBeUndefined();
      if (app.source === "winget") {
        expect(v.wingetId(app.wingetId ?? ""), `${app.key}: ${app.wingetId}`).toBeNull();
      } else {
        expect(app.source, app.key).toBe("preinstalled");
        expect(app.wingetId, app.key).toBeUndefined();
      }
    }
  });

  it("winget ids are unique and not the per-user or Store-only packages", () => {
    const ids = GALLERY.map((a) => a.wingetId).filter((id): id is string => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    // an id with a plus is a real package, and the id rule accepts it
    expect(ids).toContain("Notepad++.Notepad++");
    expect(galleryApp("notepadpp")).toMatchObject({ wingetId: "Notepad++.Notepad++", category: "tools", verified: false, exe: "{ProgramFiles}\\Notepad++\\notepad++.exe", confidence: { path: "uncertain" } });
    // Microsoft.Teams is MSIX-only, SlackTechnologies.Slack is per-user only, Zoom.Zoom.EXE is per-user (D5, plan section 7).
    for (const bad of ["Microsoft.Teams", "SlackTechnologies.Slack", "Zoom.Zoom.EXE"]) expect(ids).not.toContain(bad);
  });

  it("every website entry has a valid address, valid extra domains and known permissions", () => {
    const sites = GALLERY.filter((a) => a.kind === "web");
    expect(sites.map((a) => a.key)).toEqual(expect.arrayContaining(["teams", "slack", "outlook"]));
    for (const app of sites) {
      expect(v.webUrl(app.url ?? ""), `${app.key}: ${app.url}`).toBeNull();
      expect(v.domains(app.allowedDomains ?? []), app.key).toBeNull();
      expect(app.wingetId, app.key).toBeUndefined();
      expect(app.exe, app.key).toBeUndefined();
      for (const key of Object.keys(app.permissions ?? {})) expect(Object.keys(DEFAULT_WEB_PERMISSIONS), `${app.key}: ${key}`).toContain(key);
    }
  });

  it("Firefox carries the warning, and only Firefox", () => {
    expect(GALLERY.filter((a) => a.warning !== undefined).map((a) => a.key)).toEqual(["firefox"]);
  });

  it("nothing is marked verified before the VM check (D30)", () => {
    expect(GALLERY.every((a) => a.verified === false)).toBe(true);
  });

  it("logos: none yet (letter tiles); a set `logo` must exist as a small file", () => {
    const files = new Map<string, number>();
    for (const [path, text] of Object.entries(svgLogos)) files.set(path.replace("./logos/", ""), text.length);
    for (const path of Object.keys(otherLogos)) files.set(path.replace("./logos/", ""), 0);
    const named = GALLERY.filter((a) => a.logo !== undefined);
    for (const app of named) {
      expect(files.has(app.logo!), `${app.key}: ${app.logo}`).toBe(true);
      if (app.logo!.endsWith(".svg")) expect(files.get(app.logo!)!, `${app.key} logo size`).toBeLessThanOrEqual(4 * 1024);
    }
    // A logo file nobody uses is a leftover.
    expect([...files.keys()].sort()).toEqual(named.map((a) => a.logo!).sort());
  });

  it("looks entries up and searches names, blurbs and keys", () => {
    expect(galleryApp("vlc")?.wingetId).toBe("VideoLAN.VLC");
    expect(galleryApp("nope")).toBeUndefined();
    expect(galleryApp(null)).toBeUndefined();
    expect(searchGallery("").length).toBe(GALLERY.length);
    expect(searchGallery("  VLC ").map((a) => a.key)).toEqual(["vlc"]);
    expect(searchGallery("pdf").map((a) => a.key)).toEqual(expect.arrayContaining(["reader", "sumatra", "foxit"]));
    expect(searchGallery("browser", "browsers").every((a) => a.category === "browsers")).toBe(true);
    expect(searchGallery("zzzz")).toEqual([]);
    expect(galleryIn("all").length).toBe(GALLERY.length);
  });
});

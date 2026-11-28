import { describe, expect, it } from "vitest";
import { galleryTarget, siteOf, siteTarget, wingetIdOf, wingetTarget } from "./addSearch";

describe("wingetIdOf", () => {
  it("accepts an id and the links of winget.run, winstall.app and winget-pkgs", () => {
    expect(wingetIdOf("VideoLAN.VLC")).toBe("VideoLAN.VLC");
    expect(wingetIdOf("Notepad++.Notepad++")).toBe("Notepad++.Notepad++");
    expect(wingetIdOf("https://winget.run/pkg/Mozilla/Firefox")).toBe("Mozilla.Firefox");
    expect(wingetIdOf("winget.run/pkg/Microsoft/PowerToys")).toBe("Microsoft.PowerToys");
    expect(wingetIdOf("https://winstall.app/apps/Zoom.Zoom")).toBe("Zoom.Zoom");
    expect(wingetIdOf("https://github.com/microsoft/winget-pkgs/tree/master/manifests/v/VideoLAN/VLC/3.0.21")).toBe("VideoLAN.VLC");
  });
  it("is null for words, sentences and other links", () => {
    for (const t of ["vlc", "two words", "", "https://example.com/a", "https://winget.run/"]) expect(wingetIdOf(t)).toBeNull();
  });
});

describe("siteOf", () => {
  it("adds https:// and keeps the path; drops www in the label only", () => {
    expect(siteOf("shop.example.com/start")).toEqual({ host: "shop.example.com", url: "https://shop.example.com/start" });
    expect(siteOf("https://www.example.com")).toEqual({ host: "example.com", url: "https://www.example.com" });
  });
  it("is null for a word, a local name, an http address and a winget link", () => {
    for (const t of ["vlc", "localhost", "http://example.com", "winget.run/pkg/A/B", "has space.com"]) expect(siteOf(t)).toBeNull();
  });
});

describe("targets", () => {
  it("encode what they carry", () => {
    expect(galleryTarget("web", "teams")).toBe("/apps/new?kind=web&gallery=teams");
    expect(wingetTarget("Notepad++.Notepad++")).toBe("/apps/new?kind=desktop&winget=Notepad%2B%2B.Notepad%2B%2B");
    expect(new URLSearchParams(wingetTarget("Notepad++.Notepad++").split("?")[1]).get("winget")).toBe("Notepad++.Notepad++");
    expect(siteTarget("https://a.example.com/x?y=1")).toBe("/apps/new?kind=web&url=https%3A%2F%2Fa.example.com%2Fx%3Fy%3D1");
  });
});

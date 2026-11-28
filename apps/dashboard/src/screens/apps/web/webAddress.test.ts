import { describe, expect, it } from "vitest";
import { showAddress, showHost, withHttps, wwwDefault } from "./webAddress";

describe("withHttps", () => {
  it("adds the scheme only when there is none", () => {
    expect(withHttps("  shop.example.com/start ")).toBe("https://shop.example.com/start");
    expect(withHttps("https://shop.example.com")).toBe("https://shop.example.com");
    expect(withHttps("HTTP://x.example.com")).toBe("HTTP://x.example.com");
    expect(withHttps("")).toBe("");
    expect(withHttps("   ")).toBe("");
  });
});

describe("showAddress / showHost (D25)", () => {
  it("drops https:// and a lone slash, keeps the port, the path and an http scheme", () => {
    expect(showAddress("https://shop.example.com/").text).toBe("shop.example.com");
    expect(showAddress("https://shop.example.com:8443/start").text).toBe("shop.example.com:8443/start");
    expect(showAddress("http://shop.example.com/start").text).toBe("http://shop.example.com/start");
  });

  it("decodes an international name and keeps the ASCII form for the title", () => {
    const a = showAddress("https://www.xn--bcher-kva.de/seite");
    expect(a.text).toBe("www.bücher.de/seite");
    expect(a.title).toBe("www.xn--bcher-kva.de/seite");
    expect(showAddress("https://example.com/").title).toBeUndefined();
    expect(showHost("xn--bcher-kva.de")).toEqual({ text: "bücher.de", title: "xn--bcher-kva.de" });
    expect(showHost("example.com")).toEqual({ text: "example.com", title: undefined });
  });

  it("leaves text that is not an address as it is", () => {
    expect(showAddress("not an address")).toEqual({ text: "not an address", title: undefined });
  });
});

describe("wwwDefault (D14)", () => {
  it("selects the main domain for a www address with no level chosen yet, keeping the other entries", () => {
    expect(wwwDefault("https://www.example.com/", [])).toEqual(["example.com"]);
    expect(wwwDefault("https://www.example.com/", ["accounts.google.com"])).toEqual(["example.com", "accounts.google.com"]);
    expect(wwwDefault("https://www.shop.example.co.uk/", [])).toEqual(["example.co.uk"]);
  });

  it("does nothing for another host, an IP, a main domain, or a list that already holds a level", () => {
    expect(wwwDefault("https://shop.example.com/", [])).toBeNull();
    expect(wwwDefault("https://example.com/", [])).toBeNull();
    expect(wwwDefault("https://203.0.113.5/", [])).toBeNull();
    expect(wwwDefault("https://www.example.com/", ["example.com"])).toBeNull();
    expect(wwwDefault("https://www.example.com/", ["*.example.com"])).toBeNull();
    expect(wwwDefault("https://www.github.io/", [])).toBeNull();
    expect(wwwDefault("nonsense", [])).toBeNull();
  });
});

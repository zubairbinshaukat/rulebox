import { describe, expect, it } from "vitest";
import { isPublicSuffix, publicSuffixOf, PUBLIC_SUFFIXES } from "./publicSuffixes";
import { decodePunycode, toUnicodeHost } from "./punycode";
import {
  allows,
  alreadyIncluded,
  decide,
  levels,
  MAX_SAMPLES,
  normalizeEntry,
  parseAddress,
  registrableDomain,
  samples,
  selectedLevel,
  withLevel,
} from "./siteAccess";
import * as v from "../validate";

describe("parseAddress", () => {
  it("reads host, port and path", () => {
    expect(parseAddress("https://Shop.Example.com/start?x=1")).toEqual({ host: "shop.example.com", port: null, path: "/start", isIp: false });
    expect(parseAddress("https://shop.example.com:8443")).toEqual({ host: "shop.example.com", port: 8443, path: "/", isIp: false });
    expect(parseAddress("https://example.com:443/")?.port).toBeNull();
    expect(parseAddress("https://203.0.113.5/")).toMatchObject({ host: "203.0.113.5", isIp: true });
    expect(parseAddress("https://bücher.de/")?.host).toBe("xn--bcher-kva.de");
    expect(parseAddress("https://example.com./")?.host).toBe("example.com");
  });
  it("refuses anything that is not a usable https address", () => {
    for (const bad of ["", "   ", "example.com", "http://example.com/", "https://", "https://user@example.com/", "ftp://example.com", "not a url"]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });
});

describe("registrable domain and levels", () => {
  it("uses the list and the generic rule, never a suffix", () => {
    expect(registrableDomain("shop.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("contoso.sharepoint.com")).toBe("contoso.sharepoint.com");
    expect(registrableDomain("www.contoso.sharepoint.com")).toBe("contoso.sharepoint.com");
    expect(registrableDomain("shop.example.co.xx")).toBe("example.co.xx"); // generic rule: an unknown co.xx
    expect(registrableDomain("shop.example.com.xx")).toBe("example.com.xx");
    expect(registrableDomain("shop.example.co")).toBe("example.co"); // `.co` is a country domain itself
    expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
  });
  it("has none for a suffix, a single label or an IP", () => {
    for (const host of ["co.uk", "github.io", "sharepoint.com", "com", "localhost", "203.0.113.5", "[2001:db8::1]", "co.xx", ""]) {
      expect(registrableDomain(host), host).toBeNull();
    }
  });
  it("offers the host and its parents down to the registrable domain", () => {
    expect(levels("shop.example.com")).toEqual(["shop.example.com", "example.com"]);
    expect(levels("www.example.com")).toEqual(["www.example.com", "example.com"]);
    expect(levels("example.com")).toEqual(["example.com"]);
    expect(levels("a.b.example.co.uk")).toEqual(["a.b.example.co.uk", "b.example.co.uk", "example.co.uk"]);
    expect(levels("contoso.sharepoint.com")).toEqual(["contoso.sharepoint.com"]);
    expect(levels("203.0.113.5")).toEqual(["203.0.113.5"]);
    expect(levels("localhost")).toEqual(["localhost"]);
  });
  it("shows at most four levels (host, then the three nearest the registrable domain)", () => {
    expect(levels("a.b.c.d.example.com")).toEqual(["a.b.c.d.example.com", "c.d.example.com", "d.example.com", "example.com"]);
  });
  it("never offers a suffix as a level", () => {
    for (const host of ["a.b.example.co.uk", "x.y.github.io", "shop.example.com", "m.contoso.sharepoint.com"]) {
      for (const level of levels(host)) expect(isPublicSuffix(level), `${host}: ${level}`).toBe(false);
    }
  });
});

describe("public suffix list", () => {
  it("is small and lower-case", () => {
    expect(PUBLIC_SUFFIXES.size).toBeGreaterThan(90);
    expect(PUBLIC_SUFFIXES.size).toBeLessThan(260);
    for (const s of PUBLIC_SUFFIXES) expect(s).toBe(s.toLowerCase());
  });
  it("finds the longest suffix", () => {
    expect(publicSuffixOf("a.b.example.co.uk")).toBe("co.uk");
    expect(publicSuffixOf("x.my.salesforce.com")).toBe("my.salesforce.com");
    expect(publicSuffixOf("www.example.com")).toBe("com");
    expect(publicSuffixOf("example.xx")).toBe("xx");
    expect(isPublicSuffix("co.uk")).toBe(true);
    expect(isPublicSuffix("example.co.uk")).toBe(false);
  });
});

describe("selectedLevel and withLevel", () => {
  const host = "shop.example.com";
  it("defaults to the host and finds the broadest level in the entries", () => {
    expect(selectedLevel(host, [])).toBe(host);
    expect(selectedLevel(host, ["accounts.google.com"])).toBe(host);
    expect(selectedLevel(host, ["accounts.google.com", "example.com"])).toBe("example.com");
    expect(selectedLevel(host, ["*.example.com"])).toBe("example.com"); // a saved wildcard reads as the plain domain
    expect(selectedLevel("a.b.example.co.uk", ["b.example.co.uk"])).toBe("b.example.co.uk");
    expect(selectedLevel("a.b.example.co.uk", ["b.example.co.uk", "example.co.uk"])).toBe("example.co.uk");
  });
  it("round-trips: choosing a level writes it, choosing the host removes it, other entries stay", () => {
    const others = ["accounts.google.com", "login.live.com"];
    const wide = withLevel(host, others, "example.com");
    expect(wide).toEqual(["example.com", ...others]);
    expect(selectedLevel(host, wide)).toBe("example.com");
    const narrow = withLevel(host, wide, host);
    expect(narrow).toEqual(others);
    expect(selectedLevel(host, narrow)).toBe(host);
    // Choosing again does not duplicate; a saved wildcard of this host is replaced.
    expect(withLevel(host, ["*.example.com", ...others], "example.com")).toEqual(["example.com", ...others]);
    expect(withLevel("a.b.example.co.uk", ["example.co.uk", "x.test"], "b.example.co.uk")).toEqual(["b.example.co.uk", "x.test"]);
  });
  it("keeps entries of another host's levels", () => {
    expect(withLevel(host, ["example.org"], "example.com")).toEqual(["example.com", "example.org"]);
  });
});

describe("normalizeEntry", () => {
  const ok = (text: string) => {
    const r = normalizeEntry(text);
    return r.ok ? r.entry : r.reason;
  };
  it("accepts hosts, addresses, wildcards and Unicode, as lower-case ASCII", () => {
    expect(ok("login.example.com")).toBe("login.example.com");
    expect(ok("  Login.Example.COM  ")).toBe("login.example.com");
    expect(ok("https://Login.Example.com/x?y=1")).toBe("login.example.com");
    expect(ok("login.example.com/path")).toBe("login.example.com");
    expect(ok("*.example.com")).toBe("example.com");
    expect(ok("bücher.de")).toBe("xn--bcher-kva.de");
    expect(ok("login.example.com.")).toBe("login.example.com");
    expect(ok("accounts.google.com:443")).toBe("accounts.google.com");
    expect(ok("8.8.8.8")).toBe("8.8.8.8"); // a public IPv4 stays an exact match
  });
  it("says why it refuses", () => {
    expect(ok("")).toBe("empty");
    expect(ok("login.example.com:8443")).toBe("port");
    expect(ok("https://example.com:8443/")).toBe("port");
    for (const local of ["localhost", "x.local", "foo.localhost", "nas", "printer.internal", "10.0.0.5.nip.io"]) expect(ok(local), local).toBe("local");
    for (const ip of ["192.168.1.10", "10.0.0.1", "127.0.0.1"]) expect(ok(ip), ip).toBe("ip_private");
    for (const suffix of ["co.uk", "github.io", "sharepoint.com", "com.au", "https://co.uk/"]) expect(ok(suffix), suffix).toBe("suffix");
    for (const bad of ["not a domain!", "https://", "user@example.com", "ftp://example.com", "[2001:db8::1]", "a..b.com"]) expect(ok(bad), bad).toBe("format");
  });
  it("accepts only what the server's domain rule accepts", () => {
    for (const text of ["login.example.com", "example.com", "xn--bcher-kva.de", "a-b.example.co.uk"]) {
      const r = normalizeEntry(text);
      expect(r.ok && v.domain(r.entry) === null, text).toBe(true);
    }
  });
});

/** Copied by hand from `apps/staff-app/src-tauri/src/step15_tests.rs` (the allow-list tests): the dashboard preview must agree with the PC. */
describe("allows() agrees with the Staff App allow-list (step15_tests.rs)", () => {
  it("allow_list_matches_the_host_and_its_subdomains_only", () => {
    const a = "https://example.com/start";
    for (const yes of [
      "https://example.com/",
      "https://example.com/a/b?c=d#e",
      "https://www.example.com/",
      "https://a.b.example.com/x",
      "https://EXAMPLE.com/",
      "https://Www.Example.COM/",
      "https://example.com./",
      "https://example.com:443/",
    ]) {
      expect(allows(a, yes, []), yes).toBe(true);
    }
    for (const no of [
      "https://evil-example.com/",
      "https://notexample.com/",
      "https://example.com.evil.net/",
      "https://example.com.evil.net:443/",
      "https://example.org/",
      "https://com/",
      "https://iana.org/",
      "https://xexample.com/",
      "https://example.com@evil.net/",
      "https://evil.net/example.com",
      "https://evil.net/?u=example.com",
      "",
      "not a url",
      "example.com",
    ]) {
      expect(allows(a, no, []), no).toBe(false);
    }
  });
  it("only_https_passes", () => {
    for (const no of [
      "http://example.com/",
      "ftp://example.com/",
      "file:///C:/Windows/win.ini",
      "javascript:alert(1)",
      "data:text/html,hi",
      "about:blank",
      "blob:https://example.com/abc",
      "ws://example.com/",
      "wss://example.com/",
    ]) {
      expect(allows("https://example.com/", no, []), no).toBe(false);
    }
  });
  it("a_login_in_the_address_is_refused", () => {
    expect(allows("https://example.com/", "https://user@example.com/", [])).toBe(false);
    expect(allows("https://example.com/", "https://user:pass@example.com/", [])).toBe(false);
    expect(decide("https://example.com/", "https://user@example.com/", []).reason).toBe("login");
  });
  it("ports_must_be_listed", () => {
    const a = "https://example.com/";
    const extra = ["internal.test:8443"];
    expect(allows(a, "https://example.com:8443/", extra)).toBe(false);
    expect(allows(a, "https://example.com:444/", extra)).toBe(false);
    expect(allows(a, "https://internal.test:8443/", extra)).toBe(true);
    expect(allows(a, "https://app.internal.test:8443/", extra)).toBe(true);
    expect(allows(a, "https://internal.test/", extra)).toBe(false);
    expect(allows(a, "https://internal.test:9443/", extra)).toBe(false);
    expect(allows("https://example.com:8443/app", "https://example.com:8443/x", [])).toBe(true);
    expect(allows("https://example.com:8443/app", "https://example.com/x", [])).toBe(false);
    expect(decide(a, "https://example.com:8443/", extra).reason).toBe("port");
  });
  it("extra_domains_widen_the_list_and_bad_ones_are_ignored", () => {
    const a = "https://portal.company.com/";
    const extra = ["cdn.company.com", " Static.Company.com ", "", "http://plain.example", "https://", "not a domain!"];
    expect(allows(a, "https://cdn.company.com/a.js", extra)).toBe(true);
    expect(allows(a, "https://static.company.com/", extra)).toBe(true);
    expect(allows(a, "https://eu.cdn.company.com/", extra)).toBe(true);
    expect(allows(a, "https://company.com/", extra)).toBe(false); // a parent of an allowed host is not allowed
    expect(allows(a, "https://plain.example/", extra)).toBe(false); // an http entry never allows anything
    expect(allows(a, "https://other.com/", extra)).toBe(false);
  });
  it("ip_addresses_match_only_an_identical_entry", () => {
    expect(allows("https://10.0.0.5/", "https://10.0.0.5/", ["192.168.1.0"])).toBe(true);
    expect(allows("https://10.0.0.5/", "https://10.0.0.6/", ["192.168.1.0"])).toBe(false);
    expect(allows("https://10.0.0.5/", "https://192.168.1.0/", ["192.168.1.0"])).toBe(true);
    // A shorter entry must not make longer addresses its "subdomains".
    expect(allows("https://example.com/", "https://10.0.0.5/", ["0.5"])).toBe(false);
    expect(allows("https://10.0.0.5/", "https://0.5/", [])).toBe(false);
    expect(allows("https://10.0.0.5/", "https://[::1]/", [])).toBe(false);
    expect(allows("https://[2001:db8::1]/", "https://[2001:db8::1]/x", [])).toBe(true);
    expect(allows("https://[2001:db8::1]/", "https://[2001:db8::2]/x", [])).toBe(false);
  });
  it("look_alike_hosts_do_not_pass", () => {
    const a = "https://example.com/";
    expect(allows(a, "https://xn--exmple-cua.com/", [])).toBe(false);
    expect(allows(a, "https://еxample.com/", [])).toBe(false); // Cyrillic е
    expect(allows(a, "https://example.com%2eevil.net/", [])).toBe(false);
    // A backslash is a slash in a web address: this really is example.com, with a strange path.
    expect(allows(a, "https://example.com\\@evil.net/", [])).toBe(true);
  });
  it("the_primary_address_must_be_https_with_a_host", () => {
    expect(allows("http://example.com/", "https://example.com/", [])).toBe(false);
    expect(allows("not a url", "https://example.com/", [])).toBe(false);
    expect(allows("https://example.com", "https://example.com/", [])).toBe(true);
    expect(allows("mailto:a@b.c", "https://b.c/", [])).toBe(false);
    expect(decide("not a url", "https://example.com/", []).reason).toBe("bad_address");
  });
  it("reads a saved *.x entry as x (the picker's model), and an IDN address as its ASCII form", () => {
    expect(allows("https://shop.example.com/", "https://cdn.example.org/", ["*.example.org"])).toBe(true);
    expect(allows("https://shop.example.com/", "https://example.org/", ["*.example.org"])).toBe(true);
    expect(allows("https://bücher.de/", "https://www.xn--bcher-kva.de/", [])).toBe(true);
  });
  it("explains why", () => {
    const a = "https://shop.example.com/start";
    expect(decide(a, "https://shop.example.com/x", []).reason).toBe("own_host");
    expect(decide(a, "https://login.shop.example.com/", []).reason).toBe("entry");
    expect(decide(a, "https://mail.example.com/", ["example.com"]).reason).toBe("entry");
    expect(decide(a, "https://mail.example.com/", []).reason).toBe("not_listed");
    expect(decide(a, "http://shop.example.com/", []).reason).toBe("not_https");
  });
});

describe("alreadyIncluded", () => {
  it("is true for an entry the host or another entry already covers", () => {
    const a = "https://shop.example.com/";
    expect(alreadyIncluded(a, ["login.shop.example.com"], "login.shop.example.com")).toBe(true);
    expect(alreadyIncluded(a, ["example.com", "mail.example.com"], "mail.example.com")).toBe(true);
    expect(alreadyIncluded(a, ["example.com"], "example.com")).toBe(false);
    expect(alreadyIncluded(a, ["accounts.google.com"], "accounts.google.com")).toBe(false);
  });
});

describe("samples", () => {
  it("is empty for an unusable address", () => {
    expect(samples("", [])).toEqual([]);
    expect(samples("example.com", [])).toEqual([]);
    expect(samples("http://example.com/", [])).toEqual([]);
  });
  it("gives the start page, a page, a sub-address, a sibling and the other cases, at most 7", () => {
    const rows = samples("https://shop.example.com/start", ["accounts.google.com"]);
    expect(rows.length).toBeLessThanOrEqual(MAX_SAMPLES);
    // Eight candidates, seven rows: the bare registrable domain (lowest priority) is the one dropped.
    expect(rows.map((r) => [r.address, r.open])).toEqual([
      ["https://shop.example.com/start", true],
      ["https://shop.example.com/any-page", true],
      ["https://login.shop.example.com/", true],
      ["https://mail.example.com/", false],
      ["https://accounts.google.com/", true],
      ["https://www.wikipedia.org/", false],
      ["http://shop.example.com/start", false],
    ]);
    expect(rows[rows.length - 1]).toMatchObject({ kind: "http", open: false, reason: "not_https" });
  });
  it("with the wider level the sibling and the bare domain open", () => {
    const rows = samples("https://shop.example.com/", ["example.com"]);
    expect(rows.find((r) => r.kind === "sibling")).toMatchObject({ address: "https://mail.example.com/", open: true });
    expect(rows.find((r) => r.kind === "parent")).toMatchObject({ address: "https://example.com/", open: true });
  });
  it("skips the sibling when the host is the registrable domain, and picks another sibling label", () => {
    expect(samples("https://example.com/", []).map((r) => r.kind)).toEqual(["start", "page", "sub", "other", "http"]);
    expect(samples("https://mail.example.com/", []).find((r) => r.kind === "sibling")?.address).toBe("https://shop.example.com/");
  });
  it("shows other sites only when the host does not cover them, up to three, and never exceeds 7 rows", () => {
    const rows = samples("https://shop.example.com/", ["login.shop.example.com", "a.test", "b.test", "c.test", "d.test"]);
    const extras = rows.filter((r) => r.kind === "extra");
    // Up to three are asked for; with the cap of seven rows the last one makes room for the sibling and the other cases.
    expect(extras.map((r) => r.address)).toEqual(["https://a.test/", "https://b.test/"]);
    expect(rows.length).toBe(MAX_SAMPLES);
    expect(extras.every((r) => r.open)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(MAX_SAMPLES);
    // Under pressure the page and the bare domain go first; the start page, another website and the http form stay.
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["start", "other", "http"]));
  });
  it("uses an IP address and a port as they are", () => {
    const ip = samples("https://203.0.113.5/app", []);
    expect(ip.map((r) => r.kind)).toEqual(["start", "page", "other", "http"]);
    expect(ip[0]).toMatchObject({ address: "https://203.0.113.5/app", open: true });
    const port = samples("https://shop.example.com:8443/", ["example.com"]);
    expect(port[0]).toMatchObject({ address: "https://shop.example.com:8443/", open: true });
    expect(port.find((r) => r.kind === "sibling")).toMatchObject({ address: "https://mail.example.com:8443/", open: false, reason: "port" });
  });
  it("uses google.com as the other website for Wikipedia", () => {
    expect(samples("https://www.wikipedia.org/", []).find((r) => r.kind === "other")?.address).toBe("https://www.google.com/");
  });
});

describe("punycode display", () => {
  it("decodes labels (vectors checked against node:url domainToUnicode)", () => {
    expect(decodePunycode("bcher-kva")).toBe("bücher");
    expect(decodePunycode("mnchen-3ya")).toBe("münchen");
    expect(decodePunycode("maana-pta")).toBe("mañana");
    expect(decodePunycode("n3h")).toBe("☃");
    expect(toUnicodeHost("xn--bcher-kva.de")).toBe("bücher.de");
    expect(toUnicodeHost("shop.xn--mnchen-3ya.example.com")).toBe("shop.münchen.example.com");
    expect(toUnicodeHost("XN--BCHER-KVA.de")).toBe("bücher.de");
  });
  it("leaves plain hosts and broken labels alone", () => {
    expect(toUnicodeHost("shop.example.com")).toBe("shop.example.com");
    expect(toUnicodeHost("xn--!!!.example.com")).toBe("xn--!!!.example.com");
    expect(decodePunycode("é")).toBeNull();
  });
});

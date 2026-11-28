import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { appSiteAccessStrings as s } from "../../../lib/screenStrings/appSiteAccess";
import { SiteAccessPicker, type SiteAccessPickerProps } from "./SiteAccessPicker";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The picker as a form holds it: the list lives in the parent, every change is recorded. */
function Harness({ initial = [], onValue, onSubmit, ...rest }: { initial?: string[]; onValue?: (v: string[]) => void; onSubmit?: () => void } & Partial<SiteAccessPickerProps>) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <SiteAccessPicker
        url="https://shop.example.com/start"
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
        {...rest}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </form>
  );
}

const value = () => JSON.parse(screen.getByTestId("value").textContent ?? "[]") as string[];
const radio = (name: string) => screen.getByRole("radio", { name });
const chipList = () => within(screen.getByRole("list", { name: s.others }));
const previewRows = () => Array.from(document.querySelectorAll<HTMLElement>(".web-row"));
const rowOf = (address: string) => previewRows().find((r) => r.textContent?.startsWith(address));

describe("SiteAccessPicker: the levels", () => {
  it("offers the host and its main domain as a radio group; the host is chosen for a new address", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: s.label });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(radio("Only shop.example.com").getAttribute("aria-checked")).toBe("true");
    expect(radio("All of example.com").getAttribute("aria-checked")).toBe("false");
    // The hint says what else opens, in plain words.
    expect(screen.getByText(s.allHint("mail.example.com", "www.example.com"))).toBeTruthy();
  });

  it("choosing the main domain writes the plain name, never a star; choosing the host again takes it off", () => {
    render(<Harness />);
    fireEvent.click(radio("All of example.com"));
    expect(value()).toEqual(["example.com"]);
    expect(radio("All of example.com").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Only shop.example.com"));
    expect(value()).toEqual([]);
  });

  it("an existing list shows its level (also written with a star) and keeps the other sites", () => {
    render(<Harness initial={["*.example.com", "accounts.google.com"]} />);
    expect(radio("All of example.com").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Only shop.example.com"));
    expect(value()).toEqual(["accounts.google.com"]);
  });

  it("arrow keys, Home and End move and choose; only the chosen radio is a tab stop", () => {
    render(<Harness url="https://a.b.example.co.uk/" />);
    const names = ["Only a.b.example.co.uk", "All of b.example.co.uk", "All of example.co.uk"];
    // Never `co.uk`: it is a suffix.
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).not.toContain("All of co.uk");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(radio(names[0]!).tabIndex).toBe(0);
    expect(radio(names[1]!).tabIndex).toBe(-1);
    radio(names[0]!).focus();
    fireEvent.keyDown(radio(names[0]!), { key: "ArrowDown" });
    expect(radio(names[1]!).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio(names[1]!));
    fireEvent.keyDown(radio(names[1]!), { key: "End" });
    expect(radio(names[2]!).getAttribute("aria-checked")).toBe("true");
    expect(value()).toEqual(["example.co.uk"]);
    fireEvent.keyDown(radio(names[2]!), { key: "ArrowRight" });
    expect(radio(names[0]!).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio(names[0]!), { key: "ArrowUp" });
    expect(radio(names[2]!).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio(names[2]!), { key: "Home" });
    expect(radio(names[0]!).getAttribute("aria-checked")).toBe("true");
    expect(value()).toEqual([]);
  });

  it("a host that is its own main domain, or an IP, has no radios, only a sentence", () => {
    const { unmount } = render(<Harness url="https://example.com/" />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText(s.single("example.com"))).toBeTruthy();
    unmount();
    render(<Harness url="https://203.0.113.5/" />);
    expect(screen.getByText(s.ip)).toBeTruthy();
    // A suffix of a hosting service is never offered either.
    cleanup();
    render(<Harness url="https://contoso.sharepoint.com/" />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("the drawn address is hidden from screen readers; its parts are mouse shortcuts for the same choice", () => {
    render(<Harness />);
    const drawn = document.querySelector(".web-addr") as HTMLElement;
    expect(drawn.getAttribute("aria-hidden")).toBe("true");
    const parts = Array.from(drawn.querySelectorAll<HTMLButtonElement>("button"));
    expect(parts.map((p) => p.textContent)).toEqual(["shop", "example.com"]);
    expect(parts.every((p) => p.tabIndex === -1)).toBe(true);
    fireEvent.click(parts[1]!);
    expect(value()).toEqual(["example.com"]);
    expect(parts[0]!.getAttribute("data-state")).toBe("under");
    expect(parts[1]!.getAttribute("data-state")).toBe("in");
  });

  it("shows an international name decoded, with the ASCII form in the title", () => {
    render(<Harness url="https://www.xn--bcher-kva.de/" />);
    const only = radio("Only www.bücher.de");
    expect(only.getAttribute("title")).toBe("www.xn--bcher-kva.de");
    expect(radio("All of bücher.de")).toBeTruthy();
  });

  it("says what is missing instead of drawing: no address, an address that is not https", () => {
    const { unmount } = render(<Harness url="" />);
    expect(screen.getAllByText(s.noAddress).length).toBeGreaterThan(0);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    unmount();
    render(<Harness url="http://example.com" />);
    expect(screen.getAllByText(s.invalidAddress).length).toBeGreaterThan(0);
  });

  it("adds https:// to a bare address for the example", () => {
    render(<Harness url="shop.example.com/start" />);
    expect(radio("Only shop.example.com")).toBeTruthy();
  });
});

describe("SiteAccessPicker: other sites", () => {
  const add = (text: string) => {
    const input = screen.getByRole("textbox", { name: new RegExp(`^${s.addLabel}`) });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
    return input as HTMLInputElement;
  };

  it("Enter adds a plain lower-case name (a pasted address is cut down to its host) and never submits the form", () => {
    const submit = vi.fn();
    render(<Harness onSubmit={submit} />);
    const input = add("https://Login.Example-Pay.com/checkout?x=1");
    expect(value()).toEqual(["login.example-pay.com"]);
    expect(input.value).toBe("");
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: s.remove("login.example-pay.com") })).toBeTruthy();
  });

  it("the Add button adds too, and is off while the box is empty", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: s.addButton }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${s.addLabel}`) }), { target: { value: "cdn.example-pay.com" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(value()).toEqual(["cdn.example-pay.com"]);
  });

  it("refuses a port, a local name, a whole suffix and a repeat with a sentence, and writes nothing", () => {
    render(<Harness initial={["accounts.google.com"]} />);
    add("login.example.com:8443");
    expect(screen.getByText(s.errors.port)).toBeTruthy();
    add("printer.local");
    expect(screen.getByText(s.errors.local)).toBeTruthy();
    add("192.168.1.10");
    expect(screen.getByText(s.errors.ip_private)).toBeTruthy();
    add("co.uk");
    expect(screen.getByText(s.errors.suffix("co.uk"))).toBeTruthy();
    add("github.io");
    expect(screen.getByText(s.errors.suffix("github.io"))).toBeTruthy();
    add("accounts.google.com");
    expect(screen.getByText(s.errors.duplicate)).toBeTruthy();
    add("shop.example.com");
    expect(screen.getByText(s.errors.duplicate)).toBeTruthy();
    expect(value()).toEqual(["accounts.google.com"]);
    // The box is marked invalid and the sentence is linked to it.
    const input = screen.getByRole("textbox", { name: new RegExp(`^${s.addLabel}`) });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("an entry the chosen level already covers is shown muted, never removed by itself", () => {
    render(<Harness initial={["example.com", "mail.example.com"]} />);
    // example.com is the level (a radio); mail.example.com is under it.
    expect(radio("All of example.com").getAttribute("aria-checked")).toBe("true");
    const chip = chipList().getByText("mail.example.com").closest("li") as HTMLElement;
    expect(within(chip).getByText(s.included)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.remove("example.com") })).toBeNull();
  });

  it("removing a chip moves the focus to the next chip, or to the box after the last one", () => {
    render(<Harness initial={["a.example-pay.com", "b.example-pay.com", "c.example-pay.com"]} />);
    fireEvent.click(screen.getByRole("button", { name: s.remove("a.example-pay.com") }));
    expect(value()).toEqual(["b.example-pay.com", "c.example-pay.com"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: s.remove("b.example-pay.com") }));
    fireEvent.click(screen.getByRole("button", { name: s.remove("c.example-pay.com") }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: s.remove("b.example-pay.com") }));
    fireEvent.click(screen.getByRole("button", { name: s.remove("b.example-pay.com") }));
    expect(value()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: new RegExp(`^${s.addLabel}`) }));
    expect(screen.getByText(s.none)).toBeTruthy();
  });

  it("the sign-in buttons are toggles (aria-pressed) that add and take off their sites", () => {
    render(<Harness />);
    const ms = screen.getByRole("button", { name: s.suggestions.microsoft });
    expect(ms.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(ms);
    expect(value()).toEqual(["login.microsoftonline.com", "login.live.com"]);
    expect(ms.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: s.suggestions.google }));
    expect(value()).toEqual(["login.microsoftonline.com", "login.live.com", "accounts.google.com"]);
    fireEvent.click(ms);
    expect(value()).toEqual(["accounts.google.com"]);
    expect(ms.getAttribute("aria-pressed")).toBe("false");
  });

  it("a popular app's own suggestions replace the default ones", () => {
    render(<Harness suggestions={[{ label: "Slack sign-in", entries: ["slack.com"] }]} />);
    expect(screen.getByRole("button", { name: "Slack sign-in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.suggestions.google })).toBeNull();
  });

  it("an entry saved with a star is kept as it is, marked (*), with one note", () => {
    render(<Harness initial={["*.cdn.example-pay.com"]} />);
    expect(chipList().getByText("cdn.example-pay.com")).toBeTruthy();
    expect(screen.getByText("(*)")).toBeTruthy();
    expect(screen.getAllByText(s.wildcardNote).length).toBeGreaterThan(0);
    expect(value()).toEqual(["*.cdn.example-pay.com"]);
  });

  it("stops at 20 sites: no box, a sentence, and the sign-in buttons cannot overflow it", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `s${i}.example-pay.com`);
    render(<Harness initial={twenty} />);
    expect(screen.queryByRole("textbox", { name: new RegExp(`^${s.addLabel}`) })).toBeNull();
    expect(screen.getByText(s.max)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.suggestions.microsoft }));
    expect(value()).toEqual(twenty);
  });
});

describe("SiteAccessPicker: read-only and errors", () => {
  it("read-only: radios off, chips without remove buttons, no box and no sign-in buttons", () => {
    render(<Harness disabled initial={["accounts.google.com"]} />);
    for (const r of screen.getAllByRole("radio")) expect((r as HTMLButtonElement).disabled).toBe(true);
    expect(chipList().getByText("accounts.google.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.remove("accounts.google.com") })).toBeNull();
    expect(screen.queryByRole("textbox", { name: new RegExp(`^${s.addLabel}`) })).toBeNull();
    expect(screen.queryByRole("button", { name: s.suggestions.microsoft })).toBeNull();
    // The drawn parts cannot be clicked either.
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>(".web-addr button")[1]!);
    expect(value()).toEqual(["accounts.google.com"]);
  });

  it("shows the error under the picker and marks the radio group invalid", () => {
    render(<Harness error="Those sites are not valid." />);
    expect(screen.getByText("Those sites are not valid.")).toBeTruthy();
    expect(screen.getByRole("radiogroup").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("SiteAccessPicker: the live preview", () => {
  it("lists addresses with Opens or Blocked in words, for the host and for the other sites", () => {
    render(<Harness initial={["accounts.google.com"]} />);
    const start = rowOf("shop.example.com/start");
    expect(start?.textContent).toContain(s.preview.open);
    expect(rowOf("login.shop.example.com")?.textContent).toContain(s.preview.open);
    expect(rowOf("accounts.google.com")?.textContent).toContain(s.preview.open);
    const sibling = rowOf("mail.example.com");
    expect(sibling?.textContent).toContain(s.preview.blocked);
    expect(rowOf("www.wikipedia.org")?.textContent).toContain(s.preview.blocked);
    // The unsecured form is blocked and says why.
    const http = rowOf("http://shop.example.com/start");
    expect(http?.textContent).toContain(s.preview.blocked);
    expect(http?.textContent).toContain(s.preview.reasons.not_https);
    expect(previewRows().length).toBeLessThanOrEqual(7);
  });

  it("follows the choice at once: the sibling opens when the main domain is chosen", () => {
    render(<Harness />);
    expect(rowOf("mail.example.com")?.textContent).toContain(s.preview.blocked);
    fireEvent.click(radio("All of example.com"));
    expect(rowOf("mail.example.com")?.textContent).toContain(s.preview.open);
  });

  it("announces the count politely, once, half a second after the last change", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const live = () => screen.getAllByRole("status").find((el) => /\d+ open, \d+ blocked/.test(el.textContent ?? ""))!;
    const before = live().textContent;
    expect(live().getAttribute("aria-live")).toBe("polite");
    fireEvent.click(radio("All of example.com"));
    // The visible summary is new; what is announced is not yet.
    expect(live().textContent).toBe(before);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(live().textContent).toBe(before);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(live().textContent).not.toBe(before);
    expect(live().textContent).toMatch(/^\d+ open, \d+ blocked$/);
  });

  it("answers 'Try an address' with the same rules, and Enter in it does not submit the form", () => {
    const submit = vi.fn();
    render(<Harness onSubmit={submit} initial={["accounts.google.com"]} />);
    const input = screen.getByRole("textbox", { name: s.preview.try });
    fireEvent.change(input, { target: { value: "accounts.google.com/signin" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector(".web-try__answer")?.textContent).toContain(s.preview.tryOpen);
    fireEvent.change(input, { target: { value: "http://shop.example.com" } });
    expect(document.querySelector(".web-try__answer")?.textContent).toContain(s.preview.tryBlocked);
    fireEvent.change(input, { target: { value: "mail.example.com" } });
    expect(document.querySelector(".web-try__answer")?.textContent).toContain(s.preview.tryBlocked);
    fireEvent.click(radio("All of example.com"));
    expect(document.querySelector(".web-try__answer")?.textContent).toContain(s.preview.tryOpen);
  });

  it("notes: the path, a port, and the shared list of Edge and Chrome", () => {
    const { unmount } = render(<Harness url="https://shop.example.com:8443/start" browser="chrome" />);
    expect(screen.getByText(s.preview.pathNote("/start"))).toBeTruthy();
    expect(screen.getByText(s.preview.portNote(8443))).toBeTruthy();
    expect(screen.getByText(s.preview.browserNote)).toBeTruthy();
    unmount();
    render(<Harness url="https://shop.example.com/" browser="builtin" />);
    expect(screen.queryByText(s.preview.browserNote)).toBeNull();
    expect(screen.queryByText(s.preview.pathNote("/"))).toBeNull();
  });

  it("without a usable address the preview says so instead of listing", () => {
    render(<Harness url="" />);
    expect(previewRows()).toHaveLength(0);
    expect(screen.getAllByText(s.noAddress).length).toBeGreaterThan(0);
  });

  it("withPreview={false} leaves the preview to the caller", () => {
    render(<Harness withPreview={false} />);
    expect(screen.queryByText(s.preview.title)).toBeNull();
  });
});

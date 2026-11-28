import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { browserSitesProblem } from "../lib/apps/browserRules";
import { appAddStrings } from "../lib/screenStrings/appAdd";
import { appBrowserStrings as b } from "../lib/screenStrings/appBrowser";
import { appSiteAccessStrings as s } from "../lib/screenStrings/appSiteAccess";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";
import { initialValues, type FormValues } from "./apps/appForm";
import { blankDesktopDetail } from "./apps/desktop/model";
import { BrowserRulesCard } from "./AppBrowser";

// The chip editor of "Browser rules" (a Chrome or Edge program): the same list as the plain text, one string of lines in the form.
vi.mock("../data", () => ({ useAppOptions: () => ({ status: "ready", data: [] }) }));

afterEach(cleanup);

function Harness({ sites = "" }: { sites?: string }) {
  const f = useForm<FormValues>({ ...initialValues(blankDesktopDetail(), "desktop"), exe: "{ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe", sites }, (x) => ({
    sites: browserSitesProblem(v.lines(x.sites).map((l) => l.toLowerCase()), b.sitesTooMany) ?? undefined,
  }));
  return (
    <MemoryRouter>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async () => {});
        }}
      >
        <BrowserRulesCard f={f} />
        <button type="submit">Save</button>
        <output data-testid="sites">{f.values.sites}</output>
      </form>
    </MemoryRouter>
  );
}

const sites = () => screen.getByTestId("sites").textContent;
const box = () => screen.getByRole("textbox", { name: new RegExp(`^${b.chips.addLabel}`) }) as HTMLInputElement;
const raw = () => screen.getByRole("textbox", { name: new RegExp(`^${b.sites}`) }) as HTMLTextAreaElement;
const add = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
};

describe("BrowserRulesCard: the chip editor", () => {
  it("shows the saved sites as chips (a star kept as saved) and the plain list under Advanced", () => {
    render(<Harness sites={"portal.example.com\n*.cdn.example.com"} />);
    const list = screen.getByRole("list", { name: b.chips.legend });
    expect(within(list).getByText("portal.example.com")).toBeTruthy();
    expect(within(list).getByText("cdn.example.com")).toBeTruthy();
    expect(within(list).getByText("(*)")).toBeTruthy();
    expect(raw().value).toBe("portal.example.com\n*.cdn.example.com");
    expect(screen.getByText(appAddStrings.advanced).closest("details")).toBeTruthy();
    // The plain list of what browser mode cannot do stays.
    for (const line of b.limits) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByText(b.sitesEmpty)).toBeNull();
  });

  it("Enter adds a plain lower-case name and never submits; the warning for an empty list goes away", () => {
    render(<Harness />);
    expect(screen.getByText(b.sitesEmpty)).toBeTruthy();
    expect(screen.getByText(b.chips.none)).toBeTruthy();
    add("https://Portal.Example.com/login");
    expect(sites()).toBe("portal.example.com");
    expect(raw().value).toBe("portal.example.com");
    expect(screen.queryByText(b.sitesEmpty)).toBeNull();
    add("mail.example.com");
    expect(sites()).toBe("portal.example.com\nmail.example.com");
    // No submit happened: no error line from a save either.
    expect(document.querySelector(".dash-field__error")).toBeNull();
  });

  it("removing a chip takes the site off the list and moves the focus on", () => {
    render(<Harness sites={"a.example.com\nb.example.com"} />);
    fireEvent.click(screen.getByRole("button", { name: s.remove("a.example.com") }));
    expect(sites()).toBe("b.example.com");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: s.remove("b.example.com") }));
    fireEvent.click(screen.getByRole("button", { name: s.remove("b.example.com") }));
    expect(sites()).toBe("");
    expect(document.activeElement).toBe(box());
    expect(screen.getByText(b.sitesEmpty)).toBeTruthy();
  });

  it("refuses a port, a local name, a suffix and a repeat, like the website picker", () => {
    render(<Harness sites="portal.example.com" />);
    add("portal.example.com:8080");
    expect(screen.getByText(s.errors.port)).toBeTruthy();
    add("intranet.local");
    expect(screen.getByText(s.errors.local)).toBeTruthy();
    add("co.uk");
    expect(screen.getByText(s.errors.suffix("co.uk"))).toBeTruthy();
    add("Portal.Example.com");
    expect(screen.getByText(s.errors.duplicate)).toBeTruthy();
    expect(sites()).toBe("portal.example.com");
  });

  it("has the Microsoft and Google sign-in buttons as toggles", () => {
    render(<Harness sites="portal.example.com" />);
    const google = screen.getByRole("button", { name: s.suggestions.google });
    fireEvent.click(google);
    expect(sites()).toBe("portal.example.com\naccounts.google.com");
    expect(google.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(google);
    expect(sites()).toBe("portal.example.com");
  });

  it("stops at 200 sites", () => {
    const many = Array.from({ length: 200 }, (_, i) => `s${i}.example.com`).join("\n");
    render(<Harness sites={many} />);
    expect(screen.queryByRole("textbox", { name: new RegExp(`^${b.chips.addLabel}`) })).toBeNull();
    expect(screen.getByText(b.chips.max)).toBeTruthy();
  });

  it("a bad line typed in the plain list is refused on save, and Advanced opens to show where", () => {
    render(<Harness sites="portal.example.com" />);
    const advanced = screen.getByText(appAddStrings.advanced).closest("details") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    fireEvent.change(raw(), { target: { value: "https://portal.example.com/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/is not a host name/)).toBeTruthy();
    expect(advanced.open).toBe(true);
  });
});

import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { MemoryRouter } from "react-router";
import type { AppDetail } from "../../../data/types";
import { messageFor } from "../../../lib/errors";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appBrowserStrings } from "../../../lib/screenStrings/appBrowser";
import { appSiteAccessStrings as s } from "../../../lib/screenStrings/appSiteAccess";
import { useForm } from "../../../lib/useForm";
import { initialValues, validateValues, type FormValues } from "../appForm";
import { useWebIcon } from "./useWebIcon";
import { blankWebDetail } from "./webAddress";
import { webPayload } from "./webPayload";
import { WebAppForm } from "./WebAppForm";

// The website form against a mocked data seam (the form reads a site through `useFetchWebMeta`, stores its icon through `useSaveAppIcon`,
// and lists Chrome programs through `useAppOptions`). The add page and the Details tab around it have their own tests.
const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  saveIcon: vi.fn(),
  options: { status: "ready" as const, data: [] as unknown[] },
}));
vi.mock("../../../data", () => ({
  useFetchWebMeta: () => m.fetch,
  useSaveAppIcon: () => m.saveIcon,
  useAppOptions: () => m.options,
}));

const w = appAddStrings.web;
const site = { name: "Example Shop", hue: 150, iconPreviewUrl: "data:image/png;base64,AAAA" };

beforeEach(() => {
  m.fetch.mockReset();
  m.saveIcon.mockReset();
  m.fetch.mockResolvedValue(site);
  m.saveIcon.mockResolvedValue(undefined);
});
afterEach(cleanup);

// The form and the icon state of the page under test, for the test to reach (set in an effect, not while rendering).
const probe: { form: ReturnType<typeof useForm<FormValues>> | null; icon: ReturnType<typeof useWebIcon> | null } = { form: null, icon: null };
type Site = { name?: string; hue?: number; iconPreviewUrl?: string };

function Harness({ d = blankWebDetail(), isNew = true, readOnly = false, onSaved }: { d?: AppDetail; isNew?: boolean; readOnly?: boolean; onSaved?: (payload: ReturnType<typeof webPayload>) => void }) {
  const f = useForm<FormValues>(initialValues(d, "web"), (x) => validateValues("web", x));
  const icon = useWebIcon();
  useEffect(() => {
    probe.form = f;
    probe.icon = icon;
  });
  return (
    <MemoryRouter>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (values) => onSaved?.(webPayload(values)));
        }}
      >
        <WebAppForm d={d} f={f} isNew={isNew} readOnly={readOnly} icon={icon} />
        <button type="submit">Save</button>
        <output data-testid="state">{JSON.stringify({ name: f.values.name, url: f.values.url, domains: f.values.domains, hue: f.values.hue })}</output>
      </form>
    </MemoryRouter>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}") as { name: string; url: string; domains: string; hue: number | undefined };
const address = () => screen.getByRole("textbox", { name: new RegExp(`^${w.address}`) }) as HTMLInputElement;
const name = () => screen.getByRole("textbox", { name: /^Name/ }) as HTMLInputElement;
const typeAddress = async (text: string) => {
  fireEvent.change(address(), { target: { value: text } });
  fireEvent.blur(address());
  await waitFor(() => expect(m.fetch).toHaveBeenCalled());
};

const website = (over: Partial<AppDetail> = {}): AppDetail => ({
  ...blankWebDetail(),
  _id: "a1",
  name: "Docs",
  hue: 175,
  revision: 3,
  web: {
    url: "https://docs.example.com/",
    allowedDomains: ["docs.example.com", "accounts.google.com"],
    permissions: { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: true, geolocation: false },
  },
  ...over,
});

describe("WebAppForm: the address", () => {
  it("adds https://, reads the site once, and fills the name, colour and icon of a new website", async () => {
    render(<Harness />);
    await typeAddress("shop.example.com/start");
    expect(address().value).toBe("https://shop.example.com/start");
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(m.fetch).toHaveBeenCalledWith({ url: "https://shop.example.com/start" });
    await screen.findByText(s.form.found);
    expect(name().value).toBe("Example Shop");
    expect(state().hue).toBe(150);
    expect((document.querySelector(".dash-glyph img") as HTMLImageElement).getAttribute("src")).toBe(site.iconPreviewUrl);
    // Leaving the box again with the same address reads nothing more.
    fireEvent.blur(address());
    fireEvent.blur(address());
    expect(m.fetch).toHaveBeenCalledTimes(1);
    // "Fetch again" does.
    fireEvent.click(screen.getByRole("button", { name: w.fetchAgain }));
    await waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(2));
  });

  it("Enter finishes the address and never submits the form", async () => {
    const saved = vi.fn();
    render(<Harness onSaved={saved} />);
    fireEvent.change(address(), { target: { value: "shop.example.com" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(1));
    expect(address().value).toBe("https://shop.example.com");
    expect(saved).not.toHaveBeenCalled();
  });

  it("shows what is being read, and keeps what the person typed", async () => {
    let resolve!: (v: Site) => void;
    m.fetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<Harness />);
    fireEvent.change(name(), { target: { value: "Shop (mine)" } });
    await typeAddress("https://shop.example.com");
    expect(screen.getByText(w.fetching)).toBeTruthy();
    await act(async () => resolve(site));
    expect(name().value).toBe("Shop (mine)");
    expect(state().hue).toBe(150);
  });

  it("a name it filled is replaced when the address changes; one the person edited is not", async () => {
    render(<Harness />);
    await typeAddress("https://shop.example.com");
    await screen.findByText(s.form.found);
    m.fetch.mockResolvedValueOnce({ name: "Other Site", hue: 20 });
    fireEvent.change(address(), { target: { value: "https://other.example.org" } });
    fireEvent.blur(address());
    await waitFor(() => expect(name().value).toBe("Other Site"));
    fireEvent.change(name(), { target: { value: "Mine" } });
    m.fetch.mockResolvedValueOnce({ name: "Third", hue: 60 });
    fireEvent.change(address(), { target: { value: "https://third.example.net" } });
    fireEvent.blur(address());
    await waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(3));
    await screen.findByText(s.form.foundName);
    expect(name().value).toBe("Mine");
  });

  it("a site that cannot be read says so in one sentence and blocks nothing", async () => {
    m.fetch.mockRejectedValue(new Error("nope"));
    render(<Harness />);
    await typeAddress("https://shop.example.com");
    await screen.findByText(w.fetchFailed);
    fireEvent.change(name(), { target: { value: "Shop" } });
    expect(name().value).toBe("Shop");
    expect(screen.getByRole("button", { name: w.fetchAgain })).toBeTruthy();
  });

  it("does not read an address that is not usable", () => {
    render(<Harness />);
    fireEvent.change(address(), { target: { value: "http://shop.example.com" } });
    fireEvent.blur(address());
    fireEvent.change(address(), { target: { value: "printer.local" } });
    fireEvent.blur(address());
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("an answer for an address that has changed since is dropped", async () => {
    let resolve!: (v: Site) => void;
    m.fetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<Harness />);
    await typeAddress("https://old.example.com");
    fireEvent.change(address(), { target: { value: "https://new.example.com" } });
    fireEvent.blur(address());
    await act(async () => resolve({ name: "Old", hue: 20 }));
    await screen.findByText(s.form.found);
    expect(name().value).toBe("Example Shop");
  });
});

describe("WebAppForm: the www default and the picker", () => {
  it("a new www address starts with 'All of <domain>'; a typed choice is not undone", async () => {
    render(<Harness />);
    await typeAddress("https://www.example.com/");
    expect(screen.getByRole("radio", { name: "All of example.com" }).getAttribute("aria-checked")).toBe("true");
    expect(state().domains).toBe("example.com");
    fireEvent.click(screen.getByRole("radio", { name: "Only www.example.com" }));
    expect(state().domains).toBe("");
    fireEvent.blur(address());
    expect(state().domains).toBe("");
  });

  it("an address that is not www, and an existing website, keep their own choice", async () => {
    render(<Harness />);
    await typeAddress("https://shop.example.com/");
    expect(state().domains).toBe("");
    cleanup();
    render(<Harness d={website({ web: { ...website().web!, url: "https://www.example.com/", allowedDomains: ["www.example.com"] } })} isNew={false} />);
    fireEvent.change(address(), { target: { value: "https://www.example.org/" } });
    fireEvent.blur(address());
    expect(state().domains).toBe("");
  });

  it("the picker and the raw list under Advanced are one list", async () => {
    render(<Harness />);
    await typeAddress("https://shop.example.com/");
    fireEvent.click(screen.getByRole("button", { name: s.suggestions.google }));
    expect(state().domains).toBe("accounts.google.com");
    const raw = screen.getByRole("textbox", { name: new RegExp(`^${w.rawList}`) }) as HTMLTextAreaElement;
    expect(raw.value).toBe("accounts.google.com");
    fireEvent.change(raw, { target: { value: "accounts.google.com\ncdn.example.org" } });
    expect(within(screen.getByRole("list", { name: s.others })).getByText("cdn.example.org")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "All of example.com" }));
    expect(state().domains.split("\n")).toEqual(["example.com", "accounts.google.com", "cdn.example.org"]);
  });

  it("a bad entry in the list is refused under the picker when the form is saved, and nothing is sent", async () => {
    const saved = vi.fn();
    render(<Harness onSaved={saved} />);
    await typeAddress("https://shop.example.com/");
    fireEvent.change(name(), { target: { value: "Shop" } });
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${w.rawList}`) }), { target: { value: "https://nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const group = (await screen.findByRole("radiogroup", { name: s.label })).closest("fieldset") as HTMLElement;
    await waitFor(() => expect(group.querySelector(".dash-field__error")).toBeTruthy());
    expect(saved).not.toHaveBeenCalled();
  });

  it("the server's refusal of the list is shown under the picker", async () => {
    render(<Harness />);
    await typeAddress("https://shop.example.com/");
    const error = new ConvexError({ code: "invalid_argument", field: "allowedDomains" });
    act(() => probe.form!.setServerError(error));
    const group = screen.getByRole("radiogroup", { name: s.label }).closest("fieldset") as HTMLElement;
    expect(within(group).getByText(messageFor(error))).toBeTruthy();
  });

  it("sends the payload as before: lower-case names, the address's own host left out, no browser for the Rulebox window", async () => {
    const saved = vi.fn();
    render(<Harness onSaved={saved} />);
    await typeAddress("https://www.example.com/");
    fireEvent.change(name(), { target: { value: "  Example  " } });
    fireEvent.click(screen.getByRole("button", { name: s.suggestions.microsoft }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(saved.mock.calls[0]![0]).toEqual({
      name: "Example",
      description: undefined,
      hue: 150,
      url: "https://www.example.com/",
      allowedDomains: ["example.com", "login.microsoftonline.com", "login.live.com"],
    });
  });
});

describe("WebAppForm: more options and advanced", () => {
  it("Opens in is under More options, with the description and the colour", async () => {
    render(<Harness />);
    await typeAddress("https://shop.example.com/");
    const more = screen.getByText(appAddStrings.more).closest("details") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(within(more).getByRole("radio", { name: appBrowserStrings.kinds.builtin })).toBeTruthy();
    expect(within(more).getByRole("radio", { name: appBrowserStrings.kinds.edge })).toBeTruthy();
    expect(within(more).getByRole("textbox", { name: /^Description/ })).toBeTruthy();
    fireEvent.click(within(more).getByRole("radio", { name: appBrowserStrings.kinds.edge }));
    // The preview then says that browser websites share one list.
    expect(screen.getByText(s.preview.browserNote)).toBeTruthy();
    expect(screen.getByText(appAddStrings.advanced).closest("details")).toBeTruthy();
  });

  it("a missing Chrome program opens More options when the form is saved", async () => {
    render(<Harness />);
    await typeAddress("https://shop.example.com/");
    fireEvent.change(name(), { target: { value: "Shop" } });
    fireEvent.click(screen.getByRole("radio", { name: appBrowserStrings.kinds.chrome }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(appBrowserStrings.chromeNeeded);
    expect((screen.getByText(appAddStrings.more).closest("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("only a new website shows the permissions hint", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByText(w.permissionsHint)).toBeTruthy();
    unmount();
    render(<Harness d={website()} isNew={false} />);
    expect(screen.queryByText(w.permissionsHint)).toBeNull();
  });
});

describe("WebAppForm: an existing website", () => {
  it("starts from its saved list (the host left out), reads nothing until the address changes, and then only fills the icon", async () => {
    render(<Harness d={website()} isNew={false} />);
    expect(name().value).toBe("Docs");
    expect(state().domains).toBe("accounts.google.com");
    expect(screen.getByRole("radio", { name: "Only docs.example.com" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.blur(address());
    expect(m.fetch).not.toHaveBeenCalled();
    fireEvent.change(address(), { target: { value: "https://wiki.example.org/" } });
    fireEvent.blur(address());
    await waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(1));
    await screen.findByText(s.form.found);
    // The admin's name and colour stay.
    expect(name().value).toBe("Docs");
    expect(state().hue).toBe(175);
    expect(probe.icon!.icon).toEqual({ forUrl: "https://wiki.example.org/", data: site.iconPreviewUrl });
  });

  it("stores the previewed icon after the save, only for the address it was read for", async () => {
    render(<Harness d={website()} isNew={false} />);
    fireEvent.change(address(), { target: { value: "https://wiki.example.org/" } });
    fireEvent.blur(address());
    await screen.findByText(s.form.found);
    await act(async () => probe.icon!.save("a1", "https://elsewhere.example.org/"));
    expect(m.saveIcon).not.toHaveBeenCalled();
    await act(async () => probe.icon!.save("a1", "https://wiki.example.org/"));
    expect(m.saveIcon).toHaveBeenCalledWith({ appId: "a1", png: site.iconPreviewUrl });
    expect(probe.icon!.icon).toBeNull();
  });

  it("a failing icon upload is thrown to the caller (the app is saved by then: it only warns)", async () => {
    render(<Harness d={website()} isNew={false} />);
    fireEvent.change(address(), { target: { value: "https://wiki.example.org/" } });
    fireEvent.blur(address());
    await screen.findByText(s.form.found);
    m.saveIcon.mockRejectedValueOnce(new Error("upload failed"));
    await expect(act(async () => probe.icon!.save("a1", "https://wiki.example.org/"))).rejects.toThrow("upload failed");
  });

  it("read-only: every field is off and nothing is read", () => {
    render(<Harness d={website()} isNew={false} readOnly />);
    expect(address().closest("fieldset")?.disabled).toBe(true);
    fireEvent.change(address(), { target: { value: "https://wiki.example.org/" } });
    fireEvent.blur(address());
    expect(m.fetch).not.toHaveBeenCalled();
    for (const r of screen.getAllByRole("radio")) expect(r.matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: w.fetchAgain })).toBeNull();
  });
});

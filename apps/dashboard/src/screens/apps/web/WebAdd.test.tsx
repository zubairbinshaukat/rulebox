import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ToastProvider } from "../../../app/Toasts";
import type { Me } from "../../../data/types";
import { MeContext } from "../../../lib/member";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appSiteAccessStrings as s } from "../../../lib/screenStrings/appSiteAccess";
import { strings } from "../../../lib/strings";
import WebAdd from "./WebAdd";

// The add-a-website page against a mocked data seam: what it sends to `apps:createWeb`, what follows (the icon, a popular app's
// permissions), and where it goes after.
const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  saveIcon: vi.fn(),
  create: vi.fn(),
  setPermissions: vi.fn(),
  options: { status: "ready" as const, data: [] as unknown[] },
}));
vi.mock("../../../data", () => ({
  useFetchWebMeta: () => m.fetch,
  useSaveAppIcon: () => m.saveIcon,
  useCreateWebApp: () => m.create,
  useSetAppPermissions: () => m.setPermissions,
  useAppOptions: () => m.options,
}));

const w = appAddStrings.web;
const admin: Me = { email: "admin@x.test", role: "admin", status: "active", orgId: "org", orgName: "Acme", pin: { required: true, set: true }, serverApiVersion: 1 };
const site = { name: "Example Shop", hue: 150, iconPreviewUrl: "data:image/png;base64,AAAA" };

function Where() {
  const l = useLocation();
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
}

function ui(path: string, role: Me["role"] = "admin") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/apps/new" element={<><WebAdd /><Where /></>} />
            <Route path="/apps/:id" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}
const where = () => screen.getByTestId("where").textContent;
const address = () => screen.getByRole("textbox", { name: new RegExp(`^${w.address}`) }) as HTMLInputElement;
const name = () => screen.getByRole("textbox", { name: /^Name/ }) as HTMLInputElement;
const add = () => screen.getByRole("button", { name: w.add }) as HTMLButtonElement;

beforeEach(() => {
  for (const fn of [m.fetch, m.saveIcon, m.create, m.setPermissions]) fn.mockReset();
  m.fetch.mockResolvedValue(site);
  m.saveIcon.mockResolvedValue(undefined);
  m.create.mockResolvedValue("new1");
  m.setPermissions.mockResolvedValue({ revision: 1 });
});
afterEach(cleanup);

describe("WebAdd", () => {
  it("adds a website typed by hand: reads the site, sends the picker's list, stores the icon, then opens 'Who gets it'", async () => {
    ui("/apps/new?kind=web");
    expect(screen.getByRole("heading", { name: w.title })).toBeTruthy();
    fireEvent.change(address(), { target: { value: "www.example.com/start" } });
    fireEvent.blur(address());
    await screen.findByText(s.form.found);
    expect(name().value).toBe("Example Shop");
    // "www" starts on the whole domain; one sign-in service is added on top.
    expect(screen.getByRole("radio", { name: "All of example.com" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: s.suggestions.google }));
    fireEvent.click(add());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toEqual({
      name: "Example Shop",
      description: undefined,
      hue: 150,
      url: "https://www.example.com/start",
      allowedDomains: ["example.com", "accounts.google.com"],
    });
    await waitFor(() => expect(m.saveIcon).toHaveBeenCalledWith({ appId: "new1", png: site.iconPreviewUrl }));
    expect(m.setPermissions).not.toHaveBeenCalled();
    await waitFor(() => expect(where()).toBe("/apps/new1?tab=access&added=1"));
  });

  it("a popular website starts filled in: name, colour, address, its sign-in sites; its permissions are set after it is added", async () => {
    ui("/apps/new?kind=web&gallery=teams");
    expect(name().value).toBe("Microsoft Teams");
    expect(address().value).toBe("https://teams.microsoft.com/");
    // The site's own name and colour do not replace the popular app's.
    await waitFor(() => expect(m.fetch).toHaveBeenCalledWith({ url: "https://teams.microsoft.com/" }));
    await screen.findByText(s.form.found);
    expect(name().value).toBe("Microsoft Teams");
    expect(screen.getByRole("button", { name: s.suggestions.microsoft }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(add());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0]![0]).toMatchObject({
      name: "Microsoft Teams",
      hue: 260,
      url: "https://teams.microsoft.com/",
      allowedDomains: ["login.microsoftonline.com", "login.live.com"],
    });
    await waitFor(() => expect(m.setPermissions).toHaveBeenCalledTimes(1));
    const call = m.setPermissions.mock.calls[0]![0] as { appId: string; expectedRevision: number; permissions: Record<string, boolean> };
    expect(call).toMatchObject({ appId: "new1", expectedRevision: 0 });
    // The defaults of a new website with the popular app's switches on top.
    expect(call.permissions).toMatchObject({ camera: true, microphone: true, screenShare: true, notifications: true, clipboardRead: false, geolocation: false, printing: true });
    await waitFor(() => expect(where()).toBe("/apps/new1?tab=access&added=1"));
  });

  it("asks again for the second revision when the first is stale (the demo starts a website at 1)", async () => {
    m.setPermissions.mockRejectedValueOnce(new ConvexError({ code: "stale_edit" })).mockResolvedValueOnce({ revision: 2 });
    ui("/apps/new?kind=web&gallery=teams");
    await screen.findByText(s.form.found);
    fireEvent.click(add());
    await waitFor(() => expect(m.setPermissions).toHaveBeenCalledTimes(2));
    expect((m.setPermissions.mock.calls[1]![0] as { expectedRevision: number }).expectedRevision).toBe(1);
    await waitFor(() => expect(where()).toBe("/apps/new1?tab=access&added=1"));
  });

  it("the app is added even when the icon or the permissions cannot be stored", async () => {
    m.saveIcon.mockRejectedValue(new Error("no icon"));
    m.setPermissions.mockRejectedValue(new Error("no permissions"));
    ui("/apps/new?kind=web&gallery=teams");
    await screen.findByText(s.form.found);
    fireEvent.click(add());
    await waitFor(() => expect(where()).toBe("/apps/new1?tab=access&added=1"));
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it("a pasted address (?url=) is read at once", async () => {
    ui("/apps/new?kind=web&url=" + encodeURIComponent("https://shop.example.com/start"));
    expect(address().value).toBe("https://shop.example.com/start");
    await waitFor(() => expect(m.fetch).toHaveBeenCalledWith({ url: "https://shop.example.com/start" }));
    await waitFor(() => expect(name().value).toBe("Example Shop"));
  });

  it("an unknown or desktop popular app goes back to the start page", async () => {
    ui("/apps/new?kind=web&gallery=vlc");
    await waitFor(() => expect(where()).toBe("/apps/new?missing=1"));
  });

  it("refuses an empty form inline and sends nothing", async () => {
    ui("/apps/new?kind=web");
    fireEvent.click(add());
    expect(await screen.findByText(strings.validate.fixErrors(2))).toBeTruthy();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("shows the server's refusal of the list under the picker and not a second time in the bar", async () => {
    m.create.mockRejectedValue(new ConvexError({ code: "invalid_argument", field: "allowedDomains" }));
    ui("/apps/new?kind=web");
    fireEvent.change(address(), { target: { value: "https://shop.example.com/" } });
    fireEvent.blur(address());
    await screen.findByText(s.form.found);
    fireEvent.click(add());
    await waitFor(() => expect(m.create).toHaveBeenCalled());
    const group = (await screen.findByRole("radiogroup", { name: s.label })).closest("fieldset") as HTMLElement;
    await waitFor(() => expect(group.querySelector(".dash-field__error")).toBeTruthy());
    expect(document.querySelectorAll(".dash-notice[role=alert]")).toHaveLength(0);
  });

  it("a viewer can look but not add", () => {
    ui("/apps/new?kind=web&gallery=teams", "viewer");
    expect(add().disabled).toBe(true);
    expect(screen.getByText(appAddStrings.review.viewer)).toBeTruthy();
    expect(address().closest("fieldset")?.disabled).toBe(true);
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

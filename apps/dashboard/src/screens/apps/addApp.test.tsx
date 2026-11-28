import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Me } from "../../data/types";
import { MeContext } from "../../lib/member";
import { appAddStrings as a } from "../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../lib/screenStrings/appEdit";
import { galleryApp, GALLERY } from "./gallery/catalog";
import { settleApp } from "./testKit";

// The "Add an app" start page and the Windows app review (UI pass, add-app plan 3.1 and 11) against the LIVE data seam with the Convex React
// hooks mocked.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(Object.entries(req).map(([k, r]) => [k, cx.results[getFunctionName(r.query)]])),
  useQuery: () => undefined,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

type Mock = ((args?: unknown) => Promise<unknown>) & { withOptimisticUpdate: () => Mock };
const stable = new Map<string, Mock>();
function fnFor(name: string): Mock {
  let f = stable.get(name);
  if (!f) {
    const call = ((args?: unknown) => {
      const impl = cx.fns[name];
      if (!impl) throw new Error(`no mock for ${name}`);
      return impl(args);
    }) as Mock;
    call.withOptimisticUpdate = () => call;
    f = call;
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../../app/Toasts";
import AppEdit from "../AppEdit";

const admin: Me = { email: "admin@x.test", role: "admin", status: "active", orgId: "org", orgName: "Acme", pin: { required: true, set: true }, serverApiVersion: 1 };

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

async function ui(role: Me["role"], path: string) {
  const result = render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/apps" element={<p>apps list</p>} />
            <Route path="/apps/new" element={<AppEdit />} />
            <Route path="/apps/:id" element={<p>app page</p>} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
  await settleApp();
  return result;
}
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  cx.results = {};
  cx.fns = {};
});
afterEach(cleanup);

const SHA = "ab".repeat(32);
const search = () => screen.getByRole("searchbox", { name: a.start.searchLabel }) as HTMLInputElement;
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A link by the start of its name (a row also reads its hint). */
const hrefOf = (name: RegExp | string) => screen.getByRole("link", { name: typeof name === "string" ? new RegExp(`^${literal(name)}`) : name }).getAttribute("href");

const vlc = {
  packageId: "VideoLAN.VLC",
  version: "3.0.21",
  name: "VLC media player",
  publisher: "VideoLAN",
  install: { kind: "exe", url: "https://dl.example.com/vlc.exe", sha256: SHA, sizeBytes: 1234, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false },
};

describe("the start page", () => {
  it("shows every popular app as a card that links to its review page; a website app links to the website form", async () => {
    await ui("admin", "/apps/new");
    expect(screen.getByRole("heading", { level: 1, name: a.start.title })).toBeTruthy();
    const grid = screen.getByRole("list", { name: a.start.popular });
    expect(within(grid).getAllByRole("link")).toHaveLength(GALLERY.length);
    expect(hrefOf(/VLC media player/)).toBe("/apps/new?kind=desktop&gallery=vlc");
    expect(hrefOf(/Microsoft Teams/)).toBe("/apps/new?kind=web&gallery=teams");
    expect(screen.getAllByText(a.start.websiteBadge).length).toBeGreaterThan(0);
    expect(screen.getByText(a.start.trademarks)).toBeTruthy();
  });

  it("the category chips filter the grid", async () => {
    await ui("admin", "/apps/new");
    fireEvent.click(screen.getByRole("button", { name: a.start.categories.browsers }));
    const grid = screen.getByRole("list", { name: a.start.popular });
    expect(within(grid).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(
      GALLERY.filter((g) => g.category === "browsers").map((g) => (g.kind === "web" ? `/apps/new?kind=web&gallery=${g.key}` : `/apps/new?kind=desktop&gallery=${g.key}`)),
    );
    expect(screen.getByRole("button", { name: a.start.categories.browsers }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the search finds an app by name; with no match it says what to paste instead", async () => {
    await ui("admin", "/apps/new");
    type("vlc");
    expect(within(screen.getByRole("list", { name: a.start.popular })).getAllByRole("link")).toHaveLength(1);
    type("zzzz");
    expect(screen.getByText(a.start.noMatch)).toBeTruthy();
    expect(screen.queryByRole("list", { name: a.start.popular })).toBeNull();
  });

  it("a website address offers 'Add the website'; the link carries the address, encoded", async () => {
    await ui("admin", "/apps/new");
    type("shop.example.com/start");
    expect(hrefOf(a.start.addSite("shop.example.com"))).toBe("/apps/new?kind=web&url=https%3A%2F%2Fshop.example.com%2Fstart");
  });

  it("a winget id offers the catalogue look-up (and not a website); a '+' is encoded; a pasted winget.run or winstall link is reduced to the id", async () => {
    await ui("admin", "/apps/new");
    type("VideoLAN.VLC");
    expect(hrefOf(a.start.lookUp("VideoLAN.VLC"))).toBe("/apps/new?kind=desktop&winget=VideoLAN.VLC");
    expect(screen.queryByRole("link", { name: /Add the website/ })).toBeNull();
    type("Notepad++.Notepad++");
    expect(hrefOf(a.start.lookUp("Notepad++.Notepad++"))).toBe("/apps/new?kind=desktop&winget=Notepad%2B%2B.Notepad%2B%2B");
    type("https://winget.run/pkg/Mozilla/Firefox");
    expect(hrefOf(a.start.lookUp("Mozilla.Firefox"))).toBe("/apps/new?kind=desktop&winget=Mozilla.Firefox");
    type("https://winstall.app/apps/Zoom.Zoom");
    expect(hrefOf(a.start.lookUp("Zoom.Zoom"))).toBe("/apps/new?kind=desktop&winget=Zoom.Zoom");
    expect(screen.queryByRole("link", { name: /Add the website/ })).toBeNull();
  });

  it("Enter takes the one thing the text can mean", async () => {
    await ui("admin", "/apps/new");
    type("irfan");
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(where()).toBe("/apps/new?kind=desktop&gallery=irfanview"));
  });

  it("the other ways: a website, your own installer, and under 'More ways' a program already on the PCs and a single program file", async () => {
    await ui("admin", "/apps/new");
    expect(hrefOf(a.start.ways.website)).toBe("/apps/new?kind=web");
    expect(hrefOf(new RegExp(a.start.ways.installer))).toBe("/apps/new?kind=desktop&source=installer");
    expect(hrefOf(a.start.ways.preinstalled)).toBe("/apps/new?kind=desktop&source=preinstalled");
    expect(hrefOf(a.start.ways.portable)).toBe("/apps/new?kind=desktop&source=portable");
  });

  it("a viewer can look but not add: the cards and the ways are disabled, with a notice", async () => {
    await ui("viewer", "/apps/new");
    expect(screen.getByText(a.start.viewerNotice)).toBeTruthy();
    expect(screen.queryAllByRole("link", { name: /VLC media player/ })).toHaveLength(0);
    expect((screen.getByRole("button", { name: /VLC media player/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: a.start.ways.website })).toBeNull();
  });

  it("an unknown app in the address goes back to the start page with a sentence", async () => {
    await ui("admin", "/apps/new?kind=desktop&gallery=nope");
    expect(await screen.findByText(a.start.unknownApp)).toBeTruthy();
    expect(where()).toBe("/apps/new?missing=1");
    cleanup();
    // a website entry is never a desktop review (Teams has no winget package Rulebox can install)
    await ui("admin", "/apps/new?kind=desktop&gallery=teams");
    expect(await screen.findByText(a.start.unknownApp)).toBeTruthy();
    cleanup();
    await ui("admin", "/apps/new?kind=desktop&winget=not%20an%20id");
    expect(await screen.findByText(a.start.unknownApp)).toBeTruthy();
  });

  it("picking a card opens its review", async () => {
    cx.fns["apps:resolveWinget"] = async () => vlc;
    await ui("admin", "/apps/new");
    fireEvent.click(screen.getByRole("link", { name: /VLC media player/ }));
    expect(await screen.findByRole("heading", { level: 1, name: a.review.title("VLC media player") })).toBeTruthy();
  });
});

describe("the Windows app review of a popular app", () => {
  const nameBox = () => screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.name}`) }) as HTMLInputElement;

  it("looks the package up once, fills the form from the entry and the answer, and Add sends today's createDesktop payload for VLC", async () => {
    const resolve = vi.fn(async () => vlc);
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:resolveWinget"] = resolve;
    cx.fns["apps:createDesktop"] = createDesktop;
    await ui("admin", "/apps/new?kind=desktop&gallery=vlc");
    expect(await screen.findByText(a.silent.silent)).toBeTruthy();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ packageId: "VideoLAN.VLC" });
    expect(nameBox().value).toBe("VLC media player");
    expect(screen.getByText(a.lines.wingetFrom("3.0.21"))).toBeTruthy();
    expect(screen.getByText(a.lines.checked)).toBeTruthy();
    expect(screen.getByText(a.lines.version("3.0.21"))).toBeTruthy();
    // The program to start is known: one line, no input.
    expect(screen.getByText("Program Files\\VideoLAN\\VLC\\vlc.exe")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: new RegExp(`^${a.program.label}`) })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: a.review.add("VLC media player") }));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(createDesktop.mock.calls[0]![0]).toEqual({
      name: "VLC media player",
      description: undefined,
      hue: galleryApp("vlc")!.hue,
      desktop: {
        source: "winget",
        exe: "{ProgramFiles}\\VideoLAN\\VLC\\vlc.exe",
        args: [],
        fileArgTemplate: ["{file}"],
        resetFolders: [],
        version: "3.0.21",
        wingetId: "VideoLAN.VLC",
        wingetVersion: "3.0.21",
        install: vlc.install,
      },
    });
    // After the add the page lands on "Who gets it" with the banner flag (D18).
    await waitFor(() => expect(where()).toBe("/apps/a8?tab=access&added=1"));
  });

  it("after Add the app page opens on Who gets it with ?added=1", async () => {
    cx.fns["apps:resolveWinget"] = async () => vlc;
    cx.fns["apps:createDesktop"] = async () => "a8";
    const { container } = await ui("admin", "/apps/new?kind=desktop&gallery=vlc");
    await screen.findByText(a.silent.silent);
    fireEvent.click(screen.getByRole("button", { name: a.review.add("VLC media player") }));
    await waitFor(() => expect(where()).toBe("/apps/a8?tab=access&added=1"));
    expect(container).toBeTruthy();
  });

  it("an app that is already there is said so, with a link to it; Add still works", async () => {
    cx.fns["apps:resolveWinget"] = async () => vlc;
    cx.results["apps:byWinget"] = { _id: "a3", name: "VLC media player", archived: false };
    await ui("admin", "/apps/new?kind=desktop&gallery=vlc");
    expect(await screen.findByText(a.review.duplicate("VLC media player"))).toBeTruthy();
    expect(hrefOf(a.review.openIt)).toBe("/apps/a3");
    expect((screen.getByRole("button", { name: a.review.add("VLC media player") }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Add waits while the look-up runs, with the reason beside the button", async () => {
    let finish: (v: typeof vlc) => void = () => undefined;
    cx.fns["apps:resolveWinget"] = () => new Promise((r) => (finish = r as typeof finish));
    await ui("admin", "/apps/new?kind=desktop&gallery=vlc");
    expect(screen.getByText(a.review.blocked.resolving)).toBeTruthy();
    expect((screen.getByRole("button", { name: a.review.add("VLC media player") }) as HTMLButtonElement).disabled).toBe(true);
    finish(vlc);
    expect(await screen.findByText(a.silent.silent)).toBeTruthy();
  });

  it("a refusal of the catalogue is a plain sentence with a way forward; an unreachable catalogue can be tried again", async () => {
    cx.fns["apps:resolveWinget"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "winget_unsupported", detail: "it only offers a per-user installer" }))
      .mockRejectedValueOnce(new ConvexError({ code: "winget_unreachable" }))
      .mockResolvedValueOnce(vlc);
    await ui("admin", "/apps/new?kind=desktop&gallery=vlc");
    expect(await screen.findByText(a.unsupported.msixOrUser("VLC media player"))).toBeTruthy();
    expect(hrefOf(a.review.useInstaller)).toBe("/apps/new?kind=desktop&source=installer");
    cleanup();
    await ui("admin", "/apps/new?kind=desktop&gallery=vlc");
    expect(await screen.findByText(a.review.unreachable)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: a.review.tryAgain }));
    expect(await screen.findByText(a.silent.silent)).toBeTruthy();
  });

  it("Edge is already on the PCs: nothing is looked up, nothing is installed, and Add sends a program that is already installed", async () => {
    const resolve = vi.fn();
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a9");
    cx.fns["apps:resolveWinget"] = resolve;
    cx.fns["apps:createDesktop"] = createDesktop;
    await ui("admin", "/apps/new?kind=desktop&gallery=edge");
    expect(screen.getByText(a.silent.preinstalled)).toBeTruthy();
    expect(nameBox().value).toBe("Microsoft Edge");
    fireEvent.click(screen.getByRole("button", { name: a.review.add("Microsoft Edge") }));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(resolve).not.toHaveBeenCalled();
    expect(createDesktop.mock.calls[0]![0]).toMatchObject({ name: "Microsoft Edge", desktop: { source: "preinstalled", exe: "{ProgramFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe" } });
  });

  it("Firefox carries its honest warning", async () => {
    cx.fns["apps:resolveWinget"] = async () => ({ ...vlc, packageId: "Mozilla.Firefox", name: "Mozilla Firefox" });
    await ui("admin", "/apps/new?kind=desktop&gallery=firefox");
    expect(await screen.findByText(a.review.firefoxWarning)).toBeTruthy();
  });

  it("a viewer sees the page read-only and nothing is looked up", async () => {
    const resolve = vi.fn();
    cx.fns["apps:resolveWinget"] = resolve;
    await ui("viewer", "/apps/new?kind=desktop&gallery=vlc");
    expect(screen.getByText(a.review.viewer)).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: a.review.add("VLC media player") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a winget id typed in the search is reviewed the same way, with the name from the catalogue; the program path is asked for when it is not known", async () => {
    cx.fns["apps:resolveWinget"] = async () => ({ ...vlc, packageId: "Acme.Tool", name: "Acme Tool", publisher: "Acme", defaultInstallLocation: undefined });
    cx.fns["apps:createDesktop"] = vi.fn(async () => "a8");
    await ui("admin", "/apps/new?kind=desktop&winget=Acme.Tool");
    await screen.findByText(a.silent.silent);
    expect(nameBox().value).toBe("Acme Tool");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${a.program.label}`) }), { target: { value: "Acme\\tool.exe" } });
    fireEvent.click(screen.getByRole("button", { name: a.review.add("Acme Tool") }));
    await waitFor(() => expect(cx.fns["apps:createDesktop"]).toBeDefined());
  });
});

void galleryApp;

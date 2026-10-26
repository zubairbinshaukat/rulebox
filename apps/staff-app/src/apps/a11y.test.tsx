import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { call } from "../lib/tauri";
import { expectNoAxeViolations } from "../test/axe";
import { AppHost } from "./AppHost";

vi.mock("../lib/tauri", () => ({ call: vi.fn(), isTauri: () => true }));
vi.mock("./files/FileExplorer", () => ({ FileExplorer: () => <p>The files</p> }));
vi.mock("./viewers/ViewerHost", () => ({ ViewerHost: ({ path }: { path: string }) => <p>Viewing {path}</p> }));

const windowEvents = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    windowEvents.set(name, handler);
    return () => windowEvents.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => undefined }),
}));

const mockedCall = vi.mocked(call);

const view = (lite: boolean) => ({
  label: "app-1",
  lite,
  maximized: false,
  selected: 0,
  tabs: [
    { title: "Report.pdf", kind: "pdf", path: "Docs/Report.pdf" },
    { title: "Notes.txt", kind: "text", path: "Notes.txt" },
    { title: "Photo.png", kind: "image", path: "Photo.png" },
  ],
});

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  }
});

beforeEach(() => {
  mockedCall.mockReset();
  windowEvents.clear();
  document.title = "";
});

async function open(lite: boolean) {
  mockedCall.mockImplementation(async (cmd: string) => (cmd === "app_snapshot" ? view(lite) : undefined));
  const rendered = render(<AppHost />);
  await screen.findByText("Viewing Docs/Report.pdf");
  return rendered;
}

describe("built-in window", () => {
  it("is titled by its document, with a main landmark and named window controls", async () => {
    const { container } = await open(false);
    expect(document.title).toBe("Report.pdf - Rulebox");
    expect(screen.getByRole("main")).toBeTruthy();
    for (const name of ["Snap layouts", "Minimize", "Maximize", "Close"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    await expectNoAxeViolations(container);
  });

  it("follows the document when the tab changes", async () => {
    await open(false);
    act(() => windowEvents.get("app://state")!({ payload: { ...view(false), selected: 1 } }));
    await waitFor(() => expect(document.title).toBe("Notes.txt - Rulebox"));
  });

  it("opens the snap menu from the keyboard, walks it with the arrows, and Escape returns to the button", async () => {
    const user = userEvent.setup();
    await open(false);
    const button = screen.getByRole("button", { name: "Snap layouts" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.focus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu", { name: "Snap layouts" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Left", "Right", "Top left", "Top right", "Bottom left", "Bottom right"]);
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items[5]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("picks a snap zone with Enter and hands the focus back", async () => {
    const user = userEvent.setup();
    await open(false);
    const button = screen.getByRole("button", { name: "Snap layouts" });
    button.focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(mockedCall).toHaveBeenCalledWith("win_snap", { zone: "right" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe("Lite mode tab strip", () => {
  it("is a tab list with one tab stop, arrow keys that open the neighbour, and Delete to close", async () => {
    const user = userEvent.setup();
    const { container } = await open(true);
    const list = screen.getByRole("tablist", { name: "Open documents" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    // The close buttons are not tabs and not in the tab list's reading order.
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    await expectNoAxeViolations(container);

    tabs[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(mockedCall).toHaveBeenCalledWith("app_select_tab", { index: 1 });
    expect(document.activeElement).toBe(tabs[1]);
    await user.keyboard("{End}");
    expect(mockedCall).toHaveBeenCalledWith("app_select_tab", { index: 2 });
    await user.keyboard("{Delete}");
    expect(mockedCall).toHaveBeenCalledWith("app_close_tab", { index: 2 });
  });
});

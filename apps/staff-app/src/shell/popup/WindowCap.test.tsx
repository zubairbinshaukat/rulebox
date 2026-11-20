import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../test/axe";
import { call, type CapPrompt } from "../../lib/tauri";
import { WindowCap } from "./WindowCap";

vi.mock("../../lib/tauri", () => ({ call: vi.fn(), isTauri: () => true, anchorOf: () => null }));

const mockedCall = vi.mocked(call);

const prompt = (over: Partial<CapPrompt> = {}): CapPrompt => ({
  cap: 3,
  appName: "Orders",
  windows: [
    { label: "web-mail-1", appName: "Mail" },
    { label: "web-docs-2", appName: "Docs" },
    { label: "web-crm-3", appName: "CRM" },
  ],
  ...over,
});

function answer(handlers: Record<string, (args: unknown) => unknown>) {
  mockedCall.mockImplementation((async (command: string, args: unknown) => handlers[command]?.(args)) as never);
}

beforeEach(() => mockedCall.mockReset());
afterEach(() => cleanup());

describe("the window limit dialog (plan 4.14: asks which window to close, never closes silently)", () => {
  it("names the limit and the waiting app and lists every open window as a choice", async () => {
    answer({ window_cap_state: () => prompt() });
    const { container } = render(<WindowCap />);
    expect(await screen.findByText("Too many windows are open")).toBeTruthy();
    expect(screen.getByText(/At most 3 windows can be open at once\. Close one to open Orders\./)).toBeTruthy();
    for (const name of ["Mail", "Docs", "CRM"]) {
      expect(screen.getByRole("button", { name: `Close ${name}` })).toBeTruthy();
    }
    await expectNoAxeViolations(container);
  });

  it("says 'window' for a limit of one", async () => {
    answer({ window_cap_state: () => prompt({ cap: 1, windows: [{ label: "web-a-0", appName: "Mail" }] }) });
    render(<WindowCap />);
    expect(await screen.findByText(/At most 1 window can be open at once/)).toBeTruthy();
  });

  it("closes nothing until the employee picks: opening the dialog calls only the state query", async () => {
    answer({ window_cap_state: () => prompt() });
    render(<WindowCap />);
    await screen.findByText("Too many windows are open");
    expect(mockedCall.mock.calls.map(([command]) => command)).toEqual(["window_cap_state"]);
  });

  it("picking a window sends that window's label and nothing else", async () => {
    answer({ window_cap_state: () => prompt(), window_cap_close: () => "opened" });
    render(<WindowCap />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Docs" }));
    await waitFor(() => expect(mockedCall).toHaveBeenCalledWith("window_cap_close", { label: "web-docs-2" }));
    expect(mockedCall.mock.calls.filter(([command]) => command === "window_cap_close")).toHaveLength(1);
  });

  it("asks again with the windows that are left when the limit is still reached", async () => {
    let asked = 0;
    answer({
      window_cap_state: () => (++asked === 1 ? prompt() : prompt({ windows: [{ label: "web-docs-2", appName: "Docs" }] })),
      window_cap_close: () => "stillFull",
    });
    render(<WindowCap />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Mail" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close Mail" })).toBeNull());
    expect(screen.getByRole("button", { name: "Close Docs" })).toBeTruthy();
  });

  it("Cancel cancels the wait and closes no window; it takes the focus first", async () => {
    answer({ window_cap_state: () => prompt(), window_cap_cancel: () => undefined });
    render(<WindowCap />);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(cancel.hasAttribute("data-autofocus")).toBe(true);
    fireEvent.click(cancel);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledWith("window_cap_cancel", {}));
    expect(mockedCall.mock.calls.some(([command]) => command === "window_cap_close")).toBe(false);
  });

  it("closes itself when nothing waits any more", async () => {
    answer({ window_cap_state: () => null, popup_close: () => undefined });
    const { container } = render(<WindowCap />);
    await waitFor(() => expect(mockedCall).toHaveBeenCalledWith("popup_close", {}));
    expect(container.textContent).toBe("");
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminExitView, ExitAnswer } from "@rulebox/types";

import { call } from "../lib/tauri";
import { expectNoAxeViolations } from "../test/axe";
import { AdminExit } from "./AdminExit";

vi.mock("../lib/tauri", () => ({ call: vi.fn(), isTauri: () => true }));
vi.mock("../lib/events", () => ({ useTauriEvent: () => undefined }));

const mockedCall = vi.mocked(call);

const view: AdminExitView = { link: "linked", supported: true, enabled: true, lite: false, theme: "light" };

function backend(answer: ExitAnswer) {
  mockedCall.mockImplementation(async (cmd: string) => {
    if (cmd === "admin_exit_state") return view;
    if (cmd === "admin_exit_submit") return answer;
    return undefined;
  });
}

beforeEach(() => {
  mockedCall.mockReset();
});

describe("administrator exit dialog", () => {
  it("is one labelled form in the main landmark, with the PIN field focused and no axe violations", async () => {
    backend({ status: "wrongPin", attemptsLeft: 2 });
    const { container } = render(<AdminExit />);
    const pin = await screen.findByLabelText("Administrator PIN");
    await waitFor(() => expect(document.activeElement).toBe(pin));
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Administrator exit" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Administrator exit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out to Windows" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("closes on Escape from anywhere in the dialog", async () => {
    backend({ status: "wrongPin", attemptsLeft: 2 });
    const user = userEvent.setup();
    render(<AdminExit />);
    await screen.findByLabelText("Administrator PIN");
    await user.keyboard("{Escape}");
    expect(mockedCall).toHaveBeenCalledWith("admin_exit_close", {});
  });

  it("announces a wrong PIN once, as an alert, and gives the focus back to the field", async () => {
    backend({ status: "wrongPin", attemptsLeft: 2 });
    const user = userEvent.setup();
    render(<AdminExit />);
    const pin = await screen.findByLabelText("Administrator PIN");
    await user.type(pin, "123456{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That PIN is not right. 2 tries left.");
    // Not a live region inside a live region: one alert, nothing wrapping it.
    expect(alert.parentElement?.hasAttribute("aria-live")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(pin));
    expect((pin as HTMLInputElement).value).toBe("");
  });

  it("reads a lockout as whole minutes, not as a second-by-second countdown", async () => {
    backend({ status: "lockedOut", retryAfterMs: 125_000 });
    const user = userEvent.setup();
    render(<AdminExit />);
    await user.type(await screen.findByLabelText("Administrator PIN"), "123456{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector('[aria-hidden="true"]')?.textContent).toMatch(/^2:0\d$/);
    expect(alert.querySelector(".rb-sr-only")?.textContent).toBe("about 3 minutes");
  });
});

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellState } from "@rulebox/types";

import { __setShellStateForTests, EMPTY_SHELL_STATE } from "../../lib/store";
import { call } from "../../lib/tauri";
import { QuickSettings } from "./QuickSettings";
import { useThrottledValue } from "./useThrottledValue";

vi.mock("../../lib/tauri", () => ({
  call: vi.fn(async () => undefined),
  isTauri: () => true,
  anchorOf: () => null,
}));

const mockedCall = vi.mocked(call);

function withSystem(system: Partial<ShellState["system"]>) {
  act(() =>
    __setShellStateForTests({
      ...EMPTY_SHELL_STATE,
      display: { lite: false, theme: "light", reducedMotion: false },
      system: { ...EMPTY_SHELL_STATE.system, ...system },
    }),
  );
}

beforeEach(() => {
  mockedCall.mockReset();
  mockedCall.mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => __setShellStateForTests(EMPTY_SHELL_STATE));
  vi.useRealTimers();
});

describe("quick settings on a machine without a sound device or a controllable screen (the VM)", () => {
  it("shows a disabled volume slider with a line saying why, and no brightness", () => {
    withSystem({ volume: null, brightness: null, network: "internet" });
    render(<QuickSettings />);

    const volume = screen.getByRole("slider", { name: "Volume" });
    expect((volume as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Mute" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("no-sound-device").textContent).toBe("No sound device found on this computer.");
    expect(screen.queryByRole("slider", { name: "Brightness" })).toBeNull();
  });

  it("says the network state and that Wi-Fi is the administrator's, with nothing to switch", () => {
    withSystem({ network: "local" });
    render(<QuickSettings />);

    expect(screen.getByText("Connected, no internet")).toBeTruthy();
    expect(screen.getByText("Wi-Fi networks are set up by your administrator.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /wi-?fi/i })).toBeNull();
  });
});

describe("quick settings with a sound device and a screen that dims", () => {
  it("shows both sliders and sends the volume as a fraction", () => {
    withSystem({ volume: { level: 0.4, muted: false }, brightness: 60 });
    render(<QuickSettings />);

    const volume = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;
    expect(volume.disabled).toBe(false);
    expect(volume.value).toBe("40");
    expect((screen.getByRole("slider", { name: "Brightness" }) as HTMLInputElement).value).toBe("60");
    expect(screen.queryByTestId("no-sound-device")).toBeNull();

    fireEvent.change(volume, { target: { value: "70" } });
    expect(mockedCall).toHaveBeenCalledWith("set_volume", { level: 0.7 });
    // The thumb follows the pointer before the system has answered.
    expect(volume.value).toBe("70");
  });

  it("toggles mute from the one Mute button", () => {
    withSystem({ volume: { level: 0.4, muted: true }, brightness: null });
    render(<QuickSettings />);

    const mute = screen.getByRole("button", { name: "Mute" });
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mute);
    expect(mockedCall).toHaveBeenCalledWith("set_muted", { muted: false });
  });
});

describe("useThrottledValue", () => {
  it("sends the first change at once, then the latest at most every 80 ms", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const { result } = renderHook(() => useThrottledValue(10, send));

    act(() => result.current.change(20));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(20);

    act(() => {
      result.current.change(30);
      result.current.change(40);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.value).toBe(40);

    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(40);

    // Quiet again: the system's own value is shown.
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(result.current.value).toBe(10);
  });
});

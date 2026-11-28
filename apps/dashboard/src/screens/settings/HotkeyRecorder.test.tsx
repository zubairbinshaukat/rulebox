import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { comboOfKeyEvent, keysOf } from "./hotkeyKeys";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { exit as s } from "./strings";

afterEach(cleanup);

const key = (over: Partial<Parameters<typeof comboOfKeyEvent>[0]>) => ({
  key: "a",
  code: "KeyA",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});

describe("comboOfKeyEvent", () => {
  it("writes modifiers in the canonical order and letters by their physical key", () => {
    expect(comboOfKeyEvent(key({ key: "F", code: "KeyF", shiftKey: true, ctrlKey: true }))).toBe("Ctrl+Shift+F");
    expect(comboOfKeyEvent(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(comboOfKeyEvent(key({ key: "F12", code: "F12", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+F12");
  });
  it("ignores a lone modifier and spells the Windows key so the grammar can refuse it", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta"]) expect(comboOfKeyEvent(key({ key: k, code: `${k}Left`, ctrlKey: true }))).toBeNull();
    expect(comboOfKeyEvent(key({ key: "l", code: "KeyL", metaKey: true }))).toBe("Win+L");
  });
  it("keysOf splits the canonical text into key caps", () => {
    expect(keysOf("ctrl + shift + f12")).toEqual(["Ctrl", "Shift", "F12"]);
    expect(keysOf("???")).toEqual(["???"]);
  });
});

describe("HotkeyRecorder", () => {
  const ui = (onChange = vi.fn(), value = "Ctrl+Shift+F12") => {
    render(<HotkeyRecorder value={value} onChange={onChange} />);
    return onChange;
  };
  const listen = () => fireEvent.click(screen.getByRole("button", { name: s.change }));
  const pad = () => screen.getByRole("group", { name: s.recordingLabel });

  it("shows the current keys as caps and a Change button", () => {
    ui();
    expect(screen.getByRole("img", { name: s.hotkeyNow("Ctrl + Shift + F12") })).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("listens after Change: a valid combination is handed over in canonical form and listening stops", () => {
    const onChange = ui();
    listen();
    expect(screen.getByText(s.recording)).toBeTruthy();
    expect(screen.getByText(s.recordingHint)).toBeTruthy();
    fireEvent.keyDown(pad(), key({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true }));
    expect(onChange).toHaveBeenCalledWith("Ctrl+Alt+Q");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("a lone modifier keeps listening and says nothing", () => {
    const onChange = ui();
    listen();
    fireEvent.keyDown(pad(), key({ key: "Control", code: "ControlLeft", ctrlKey: true }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: s.recordingLabel })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Esc cancels without a change", () => {
    const onChange = ui();
    listen();
    fireEvent.keyDown(pad(), key({ key: "Escape", code: "Escape" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("a combination the grammar refuses is explained and listening goes on", () => {
    const onChange = ui();
    listen();
    fireEvent.keyDown(pad(), key({ key: "F12", code: "F12", shiftKey: true }));
    expect(screen.getByRole("alert").textContent).toMatch(/add Ctrl or Alt/);
    fireEvent.keyDown(pad(), key({ key: "l", code: "KeyL", metaKey: true }));
    expect(screen.getByRole("alert").textContent).toMatch(/Windows key combinations are reserved/);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: s.recordingLabel })).toBeTruthy();
  });

  it("leaving the pad cancels", () => {
    ui();
    listen();
    fireEvent.blur(pad());
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("a disabled recorder has no Change button", () => {
    render(<HotkeyRecorder value="Ctrl+Alt+K" onChange={() => undefined} disabled />);
    expect(screen.queryByRole("button", { name: s.change })).toBeNull();
    expect(screen.getByRole("img", { name: s.hotkeyNow("Ctrl + Alt + K") })).toBeTruthy();
  });
});

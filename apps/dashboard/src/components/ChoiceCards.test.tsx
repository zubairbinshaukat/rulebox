import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceCards, type ChoiceOption } from "./ChoiceCards";

const OPTIONS: ChoiceOption[] = [
  { value: "banner", label: "Banner", hint: "A strip at the top. People can close it.", art: <svg data-testid="art" /> },
  { value: "full", label: "Full screen", hint: "Covers the screen until someone presses OK." },
  { value: "off", label: "Off", disabled: true },
];

function Harness({ initial = "banner", onChange, disabled }: { initial?: string | null; onChange?: (v: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <ChoiceCards
      name="style"
      aria-label="Style"
      value={value}
      options={OPTIONS}
      disabled={disabled}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const radios = () => screen.getAllByRole("radio");

describe("ChoiceCards", () => {
  it("is a radiogroup of cards named by label and hint, with the chosen one checked", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Style" })).toBeTruthy();
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    const full = screen.getByRole("radio", { name: "Full screen" });
    expect(full.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(full.getAttribute("aria-describedby")!)?.textContent).toBe("Covers the screen until someone presses OK.");
    // The drawing is decoration.
    expect(screen.getByTestId("art").closest("[aria-hidden='true']")).toBeTruthy();
  });

  it("has one tab stop: the chosen card, else the first enabled one", () => {
    const { unmount } = render(<Harness />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    unmount();
    render(<Harness initial={null} />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("chooses with a click and does not repeat the same choice", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "Full screen" }));
    expect(onChange).toHaveBeenCalledWith("full");
    expect(screen.getByRole("radio", { name: "Full screen" }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: "Full screen" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("moves and chooses with the arrow keys, skipping disabled cards, and wraps", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Banner" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Full screen" }));
    expect(onChange).toHaveBeenLastCalledWith("full");
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith("banner");
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("full");
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("banner");
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("full");
    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith("banner");
  });

  it("leaves the group with one Tab", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <Harness />
        <button type="button">after</button>
      </>,
    );
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Banner" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "after" }));
  });

  it("does not choose a disabled card, or anything while the group is disabled", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "Off" }));
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Harness onChange={onChange} disabled />);
    await user.click(screen.getByRole("radio", { name: "Full screen" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("submits the chosen value with a form through its name", () => {
    const { container } = render(<Harness initial="full" />);
    expect((container.querySelector('input[name="style"]') as HTMLInputElement).value).toBe("full");
  });

  it("lays out 2 or 3 across by the number of options unless told", () => {
    const { container, rerender } = render(<ChoiceCards value="a" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} aria-label="x" />);
    expect(container.querySelector(".dash-cc__grid")?.getAttribute("data-columns")).toBe("2");
    rerender(<ChoiceCards value="a" onChange={() => {}} options={OPTIONS} columns={2} aria-label="x" />);
    expect(container.querySelector(".dash-cc__grid")?.getAttribute("data-columns")).toBe("2");
  });
});

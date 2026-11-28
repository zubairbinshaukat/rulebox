import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoTip } from "@rulebox/ui";
import { Field, FieldSet } from "./Field";

const button = () => screen.getByRole("button", { name: "About kiosk mode" });

function show(onKeyDown?: () => void) {
  return render(
    <div onKeyDown={onKeyDown}>
      <InfoTip label="About kiosk mode">Locks the PC to the apps you allow.</InfoTip>
      <button type="button">Next</button>
    </div>,
  );
}

describe("InfoTip", () => {
  it("is a closed (i) button with the given name", () => {
    show();
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on keyboard focus, linked with aria-describedby, and hides on blur", async () => {
    const user = userEvent.setup();
    show();
    await user.tab();
    expect(document.activeElement).toBe(button());
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("Locks the PC to the apps you allow.");
    expect(button().getAttribute("aria-describedby")).toBe(tip.id);
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button().getAttribute("aria-describedby")).toBeNull();
  });

  it("Escape hides it and does not reach a dialog around it", async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    show(outer);
    await user.tab();
    outer.mockClear();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("shows after a short hover and hides when the pointer leaves", async () => {
    const user = userEvent.setup();
    show();
    await user.hover(button());
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(await screen.findByRole("tooltip", {}, { timeout: 1500 })).toBeTruthy();
    await user.unhover(button());
    await vi.waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull(), { timeout: 1500 });
  });

  it("a click pins it open (touch: tap); another click, or a tap outside, closes it", async () => {
    const user = userEvent.setup();
    show();
    await user.click(button());
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(button().getAttribute("aria-expanded")).toBe("true");
    await user.click(button());
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(button());
    expect(screen.getByRole("tooltip")).toBeTruthy();
    await user.click(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens from a touch tap with no hover", async () => {
    const user = userEvent.setup();
    show();
    await user.pointer({ keys: "[TouchA]", target: button() });
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});

describe("Field info", () => {
  it("renders an (i) beside the label without changing the label's name", async () => {
    const user = userEvent.setup();
    render(
      <Field label="Kiosk mode" info="Locks the PC to the apps you allow.">
        {(p) => <input {...p} />}
      </Field>,
    );
    expect(screen.getByLabelText("Kiosk mode").tagName).toBe("INPUT");
    const tip = screen.getByRole("button", { name: "About Kiosk mode" });
    expect(tip.closest("label")).toBeNull();
    await user.click(tip);
    expect(screen.getByRole("tooltip").textContent).toBe("Locks the PC to the apps you allow.");
  });

  it("has no (i) without info, and takes infoLabel for a non-text label", () => {
    const { rerender } = render(<Field label="Name">{(p) => <input {...p} />}</Field>);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <Field label={<b>Name</b>} info="Shown in lists." infoLabel="About the name">
        {(p) => <input {...p} />}
      </Field>,
    );
    expect(screen.getByRole("button", { name: "About the name" })).toBeTruthy();
    rerender(
      <Field label={<b>Name</b>} info="Shown in lists.">
        {(p) => <input {...p} />}
      </Field>,
    );
    expect(screen.getByRole("button", { name: "More information" })).toBeTruthy();
  });

  it("FieldSet keeps its name clean and adds the (i)", () => {
    render(
      <FieldSet legend="Who sees it" info="Only the groups you tick.">
        <input type="checkbox" aria-label="Front desk" />
      </FieldSet>,
    );
    expect(screen.getByRole("group", { name: "Who sees it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "About Who sees it" })).toBeTruthy();
  });
});

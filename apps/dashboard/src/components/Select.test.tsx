import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select, type SelectOption } from "@rulebox/ui";
import { Field } from "./Field";

const OPTIONS: SelectOption[] = [
  { value: "front", label: "Front desk", hint: "12 PCs" },
  { value: "office", label: "Back office", disabled: true },
  { value: "kitchen", label: "Kitchen" },
  { value: "bar", label: "Bar" },
  { value: "back", label: "Backyard" },
];

function Harness({
  initial = "front",
  options = OPTIONS,
  onChange,
  name,
  onOuterKeyDown,
}: {
  initial?: string;
  options?: SelectOption[];
  onChange?: (v: string) => void;
  name?: string;
  onOuterKeyDown?: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div onKeyDown={onOuterKeyDown}>
      <Select
        aria-label="Group"
        value={value}
        options={options}
        name={name}
        placeholder="Pick one"
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <button type="button">After</button>
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: "Group" });
const listbox = () => screen.getByRole("listbox");
const active = () => listbox().getAttribute("aria-activedescendant");
const optionId = (name: string) => screen.getByRole("option", { name: new RegExp(name) }).id;

describe("Select", () => {
  it("shows the chosen label, with the button's ARIA for a listbox", () => {
    render(<Harness />);
    expect(trigger().textContent).toBe("Front desk");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("title")).toBe("Front desk");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the placeholder when the value matches no option", () => {
    render(<Harness initial="" />);
    expect(trigger().textContent).toBe("Pick one");
  });

  it("opens with the keyboard on the chosen option, moves with arrows and chooses with Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(listbox().id);
    expect(document.activeElement).toBe(listbox());
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByRole("option", { name: /Front desk/ }).getAttribute("aria-selected")).toBe("true");
    expect(active()).toBe(optionId("Front desk"));

    await user.keyboard("{ArrowDown}"); // "Back office" is disabled: skipped
    expect(active()).toBe(optionId("Kitchen"));
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(optionId("Bar"));
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(optionId("Kitchen"));
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("kitchen");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().textContent).toBe("Kitchen");
    expect(document.activeElement).toBe(trigger());
  });

  it("opens with Enter and with Space", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).not.toBeNull();
    await user.keyboard("{Escape}");
    await user.keyboard(" ");
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });

  it("jumps with Home and End, and skips disabled options at the ends", async () => {
    const user = userEvent.setup();
    render(<Harness options={[{ value: "x", label: "Off", disabled: true }, ...OPTIONS, { value: "z", label: "Gone", disabled: true }]} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{End}");
    expect(active()).toBe(optionId("Backyard"));
    await user.keyboard("{Home}");
    expect(active()).toBe(optionId("Front desk"));
  });

  it("matches typed letters (type-ahead), cycling on a repeated letter", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("k");
    expect(active()).toBe(optionId("Kitchen"));
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("b"); // Bar comes next after the chosen option ("Front desk"); Back office is disabled
    expect(active()).toBe(optionId("Bar"));
    await user.keyboard("b");
    expect(active()).toBe(optionId("Backyard"));
  });

  it("matches several typed letters as a prefix", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("bac");
    expect(active()).toBe(optionId("Backyard"));
  });

  it("opens on a letter typed on the closed trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("k");
    expect(active()).toBe(optionId("Kitchen"));
  });

  it("Escape closes without a change, returns focus to the trigger and does not close a dialog around it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const outer = vi.fn();
    render(<Harness onChange={onChange} onOuterKeyDown={outer} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    outer.mockClear();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("Front desk");
    expect(document.activeElement).toBe(trigger());
    expect(outer).not.toHaveBeenCalled();
  });

  it("Tab chooses nothing, closes, and carries on to the next control", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("opens and chooses with the mouse; a disabled option does nothing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: /Back office/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeNull();
    await user.click(screen.getByRole("option", { name: "Bar" }));
    expect(onChange).toHaveBeenCalledWith("bar");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on a click outside, and on a second click on the trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).not.toBeNull();
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(trigger());
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds a hidden input with the value when it has a name", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness name="group" />);
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="group"]');
    expect(hidden?.value).toBe("front");
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "Kitchen" }));
    expect(container.querySelector<HTMLInputElement>('input[name="group"]')?.value).toBe("kitchen");
  });

  it("has no hidden input without a name", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(<Select aria-label="Group" value="front" onChange={() => {}} options={OPTIONS} disabled />);
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is named by a Field's label and takes its description and invalid state", () => {
    render(
      <Field label="Group" hint="Where the PC sits" error="Pick a group" required>
        {(p) => <Select {...p} value="" onChange={() => {}} options={OPTIONS} />}
      </Field>,
    );
    const button = screen.getByLabelText("Group");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-invalid")).toBe("true");
    expect(button.getAttribute("aria-required")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toMatch(/\S/);
  });
});

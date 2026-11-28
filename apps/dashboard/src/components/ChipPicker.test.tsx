import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SelectOption } from "@rulebox/ui";
import { ChipPicker } from "./ChipPicker";

const OPTIONS: SelectOption[] = [
  { value: "front", label: "Front desk" },
  { value: "kitchen", label: "Kitchen" },
  { value: "office", label: "Back office" },
  { value: "store", label: "Store room" },
];

const MANY: SelectOption[] = Array.from({ length: 16 }, (_, i) => ({ value: `g${i}`, label: `Group ${i + 1}` }));

function Harness({
  initial = [],
  options = OPTIONS,
  max,
  disabled,
  onChange,
}: {
  initial?: string[];
  options?: SelectOption[];
  max?: number;
  disabled?: boolean;
  onChange?: (v: string[]) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ChipPicker
      label="Groups"
      value={value}
      options={options}
      max={max}
      disabled={disabled}
      emptyText="No groups chosen yet"
      searchPlaceholder="Search groups"
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const group = () => screen.getByRole("group", { name: "Groups" });
const chips = () => within(group()).queryAllByRole("listitem").filter((li) => li.classList.contains("dash-pick__chip"));
const names = () => chips().map((c) => c.querySelector(".dash-pick__name")?.textContent);
const add = () => screen.getByRole("button", { name: "Groups: Add…" });
const status = () => within(group()).getByRole("status").textContent;

describe("ChipPicker", () => {
  it("is a labelled group with a chip per chosen value, the empty text, and the count", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByText("No groups chosen yet")).toBeTruthy();
    expect(names()).toEqual([]);
    expect(status()).toBe("0 selected");
    unmount();
    render(<Harness initial={["kitchen", "front"]} />);
    expect(screen.queryByText("No groups chosen yet")).toBeNull();
    expect(names()).toEqual(["Kitchen", "Front desk"]);
    expect(status()).toBe("2 selected");
  });

  it("adds from the searchable list, which no longer offers what is chosen", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={["front"]} onChange={onChange} />);
    await user.click(add());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Kitchen", "Back office", "Store room"]);
    await user.type(screen.getByRole("combobox", { name: "Search groups" }), "off");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(["front", "office"]);
    expect(names()).toEqual(["Front desk", "Back office"]);
    expect(status()).toBe("2 selected");
    // The focus is back on the Add button.
    expect(document.activeElement).toBe(add());
  });

  it("removes a chip with its button, named after it, and keeps the focus in the group", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={["front", "kitchen", "office"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Remove Kitchen" }));
    expect(onChange).toHaveBeenCalledWith(["front", "office"]);
    expect(names()).toEqual(["Front desk", "Back office"]);
    // The chip that took its place has the focus.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Back office" }));
    await user.click(screen.getByRole("button", { name: "Remove Back office" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Front desk" }));
    await user.click(screen.getByRole("button", { name: "Remove Front desk" }));
    expect(names()).toEqual([]);
    expect(document.activeElement).toBe(add());
    expect(status()).toBe("0 selected");
  });

  it("takes the last chip off with Backspace on the Add button or in its empty search box", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["front", "kitchen", "office"]} />);
    add().focus();
    await user.keyboard("{Backspace}");
    expect(names()).toEqual(["Front desk", "Kitchen"]);
    await user.click(add());
    const box = screen.getByRole("combobox", { name: "Search groups" });
    await user.type(box, "x");
    await user.keyboard("{Backspace}");
    expect(names()).toEqual(["Front desk", "Kitchen"]);
    await user.keyboard("{Backspace}");
    expect(names()).toEqual(["Front desk"]);
  });

  it("reaches every control with Tab, in order", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["front", "kitchen"]} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Front desk" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Kitchen" }));
    await user.tab();
    expect(document.activeElement).toBe(add());
  });

  it("folds chips after 12 behind +N more and back", async () => {
    const user = userEvent.setup();
    render(<Harness initial={MANY.slice(0, 15).map((o) => o.value)} options={MANY} />);
    expect(chips()).toHaveLength(12);
    const more = screen.getByRole("button", { name: "+3 more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    // The count is of all the chips, not of the visible ones.
    expect(status()).toBe("15 selected");
    await user.click(more);
    expect(chips()).toHaveLength(15);
    const fewer = screen.getByRole("button", { name: "Show fewer" });
    expect(fewer.getAttribute("aria-expanded")).toBe("true");
    await user.click(fewer);
    expect(chips()).toHaveLength(12);
  });

  it("stops at max: no Add button, a line says so", () => {
    render(<Harness initial={["front", "kitchen"]} max={2} />);
    expect(screen.queryByRole("button", { name: "Groups: Add…" })).toBeNull();
    expect(screen.getByText("That is the most you can add.")).toBeTruthy();
  });

  it("has no Add button when everything is chosen, and shows an unknown value as it is", () => {
    render(<Harness initial={["front", "kitchen", "office", "store", "gone"]} />);
    expect(screen.queryByRole("button", { name: "Groups: Add…" })).toBeNull();
    expect(names()).toContain("gone");
  });

  it("is read-only when disabled: chips only", () => {
    render(<Harness initial={["front"]} disabled />);
    expect(names()).toEqual(["Front desk"]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("can be named by another element", () => {
    render(
      <>
        <h3 id="lbl">Where they sign in</h3>
        <ChipPicker label="x" labelledBy="lbl" value={[]} options={OPTIONS} emptyText="None" onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole("group", { name: "Where they sign in" })).toBeTruthy();
  });
});

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchSelect, type SelectOption } from "@rulebox/ui";

const OPTIONS: SelectOption[] = [
  { value: "zoom", label: "Zoom" },
  { value: "cafe", label: "Café Till", hint: "Point of sale" },
  { value: "chrome", label: "Chrome" },
  { value: "slack", label: "Slack", disabled: true },
  { value: "teams", label: "Teams" },
];

function Harness({
  options = OPTIONS,
  onChange,
  onSearch,
  loading,
}: {
  options?: SelectOption[];
  onChange?: (v: string) => void;
  onSearch?: (t: string) => void;
  loading?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <SearchSelect
      aria-label="App"
      value={value}
      options={options}
      placeholder="Choose an app"
      searchPlaceholder="Search apps"
      emptyText="No app found"
      onSearch={onSearch}
      loading={loading}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const trigger = () => screen.getByRole("button", { name: "App" });
const search = () => screen.getByRole("combobox", { name: "Search apps" });
const shown = () => screen.queryAllByRole("option").map((o) => o.textContent?.replace(/Point of sale/, ""));

describe("SearchSelect", () => {
  it("opens with a search box that has focus and the combobox ARIA", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(trigger().textContent).toBe("Choose an app");
    await user.click(trigger());
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute("aria-autocomplete")).toBe("list");
    expect(search().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(shown()).toHaveLength(5);
  });

  it("filters while typing, ignoring case and accents", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.type(search(), "CAFE");
    expect(shown()).toEqual(["Café Till"]);
    await user.clear(search());
    await user.type(search(), "ch");
    expect(shown()).toEqual(["Chrome"]);
  });

  it("matches the hint too", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.type(search(), "point of");
    expect(shown()).toEqual(["Café Till"]);
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.type(search(), "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No app found")).toBeTruthy();
  });

  it("highlights the first match, moves with arrows, and Enter chooses", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.type(search(), "c");
    const first = screen.getAllByRole("option")[0]!;
    expect(search().getAttribute("aria-activedescendant")).toBe(first.id);
    await user.keyboard("{ArrowDown}");
    expect(search().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]!.id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("chrome");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().textContent).toBe("Chrome");
    expect(document.activeElement).toBe(trigger());
  });

  it("skips disabled options with the arrows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}"); // Zoom, Café, Chrome, (Slack disabled) Teams
    expect(search().getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Teams" }).id);
  });

  it("Escape clears the text first, then closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.type(search(), "zo");
    expect(shown()).toEqual(["Zoom"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeNull();
    expect((search() as HTMLInputElement).value).toBe("");
    expect(shown()).toHaveLength(5);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("hands the text to onSearch and shows the options as given, without filtering", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    await user.click(trigger());
    await user.type(search(), "zz");
    expect(onSearch).toHaveBeenLastCalledWith("zz");
    expect(shown()).toHaveLength(5);
  });

  it("shows the loading text", async () => {
    const user = userEvent.setup();
    render(<Harness onSearch={() => {}} loading />);
    await user.click(trigger());
    expect(screen.getByRole("status").textContent).toBe("Loading…");
  });

  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

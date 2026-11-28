import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function setup(items: MoreMenuItem[], label?: string) {
  return render(
    <MemoryRouter initialEntries={["/groups/1"]}>
      <button type="button">before</button>
      <MoreMenu items={items} label={label} />
      <Where />
    </MemoryRouter>,
  );
}

const button = (name = "More") => screen.getByRole("button", { name });
const labels = () => screen.queryAllByRole("menuitem").map((i) => i.textContent);

describe("MoreMenu", () => {
  it("is a menu button that opens a menu of items and puts the focus on the first", async () => {
    const user = userEvent.setup();
    setup([{ label: "Rename", onSelect: () => {} }, { label: "Staged rollout", to: "/groups/1/rollout" }]);
    const b = button();
    expect(b.getAttribute("aria-haspopup")).toBe("menu");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "More" }).id).toBe(b.getAttribute("aria-controls"));
    expect(labels()).toEqual(["Rename", "Staged rollout"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
  });

  it("opens with Arrow Down (first item) or Arrow Up (last item) and moves with the arrows, Home and End", async () => {
    const user = userEvent.setup();
    setup([{ label: "One", onSelect: () => {} }, { label: "Two", onSelect: () => {} }, { label: "Three", onSelect: () => {} }]);
    button().focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "One" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Two" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Three" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "One" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Three" }));
  });

  it("opens with Enter and closes with Esc, giving the focus back to the button", async () => {
    const user = userEvent.setup();
    setup([{ label: "Rename", onSelect: () => {} }]);
    button().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("keeps the Escape from reaching a dialog around it", async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    render(
      <MemoryRouter>
        <div onKeyDown={outer}>
          <MoreMenu items={[{ label: "Rename", onSelect: () => {} }]} />
        </div>
      </MemoryRouter>,
    );
    await user.click(button());
    outer.mockClear();
    await user.keyboard("{Escape}");
    expect(outer).not.toHaveBeenCalled();
  });

  it("runs an item, closes, and returns the focus", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    setup([{ label: "Rename", onSelect }]);
    await user.click(button());
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("goes to the page of a `to` item", async () => {
    const user = userEvent.setup();
    setup([{ label: "Staged rollout", to: "/groups/1/rollout" }]);
    await user.click(button());
    await user.click(screen.getByRole("menuitem", { name: "Staged rollout" }));
    expect(screen.getByTestId("where").textContent).toBe("/groups/1/rollout");
  });

  it("leaves out hidden items, puts danger items last after a divider, and draws nothing with no items", async () => {
    const user = userEvent.setup();
    const { unmount } = setup([
      { label: "Delete group", danger: true, onSelect: () => {} },
      { label: "Rename", onSelect: () => {} },
      { label: "Secret", hidden: true, onSelect: () => {} },
      { label: "Send a message", onSelect: () => {} },
    ]);
    await user.click(button());
    expect(labels()).toEqual(["Rename", "Send a message", "Delete group"]);
    const items = screen.getAllByRole("menuitem");
    const sep = screen.getByRole("separator");
    expect(sep.nextElementSibling).toBe(items[2]);
    expect(items[2]!.className).toContain("rb-menu__item--danger");
    unmount();
    const { container } = setup([{ label: "Secret", hidden: true, onSelect: () => {} }]);
    expect(container.querySelector("button[aria-haspopup]")).toBeNull();
  });

  it("closes on a click outside and on Tab", async () => {
    const user = userEvent.setup();
    setup([{ label: "Rename", onSelect: () => {} }]);
    await user.click(button());
    await user.click(screen.getByText("before"));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(button());
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("uses the label for the button and the menu", async () => {
    const user = userEvent.setup();
    setup([{ label: "Rename", onSelect: () => {} }], "More for this group");
    await user.click(button("More for this group"));
    expect(screen.getByRole("menu", { name: "More for this group" })).toBeTruthy();
  });
});

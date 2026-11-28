import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RowActions } from "./RowActions";
import type { RowAction } from "./DataTable";

/** The real "More actions" button: enabled once the lazy menu module has loaded. */
const moreButton = (name: string) =>
  waitFor(() => {
    const b = screen.getByRole("button", { name: `More actions for ${name}` }) as HTMLButtonElement;
    if (b.disabled) throw new Error("menu still loading");
    return b;
  });

const act = (label: string, over: Partial<RowAction> = {}): RowAction => ({ label, onSelect: vi.fn(), ...over });

describe("RowActions", () => {
  it("renders nothing without actions", () => {
    const { container } = render(<RowActions actions={[]} rowName="VM" />);
    expect(container.firstChild).toBeNull();
  });

  it("one or two actions are small buttons named with the record", () => {
    const edit = act("Edit");
    const remove = act("Remove", { danger: true });
    render(<RowActions actions={[edit, remove]} rowName="Group A" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit: Group A" }));
    expect(edit.onSelect).toHaveBeenCalledTimes(1);
    const del = screen.getByRole("button", { name: "Remove: Group A" });
    expect(del.className).toContain("rb-btn--danger-ghost");
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("a disabled action keeps its reason as a hint", () => {
    render(<RowActions actions={[act("Retry", { disabled: true, hint: "This app can't be retried" })]} rowName="7-Zip" />);
    const btn = screen.getByRole("button", { name: "Retry: 7-Zip" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("This app can't be retried");
  });

  describe("more than two", () => {
    const four = () => [act("Reset code"), act("Change role", { primary: true }), act("Disable", { danger: true }), act("Reset sign-in")];

    it("the primary action stays inline, the rest go behind More actions, destructive items last", async () => {
      render(<RowActions actions={four()} rowName="ann@x.test" />);
      expect(screen.getByRole("button", { name: "Change role: ann@x.test" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Reset code/ })).toBeNull();
      // The menu is a lazy chunk: its button replaces a blank placeholder a moment after the first render.
      fireEvent.click(await moreButton("ann@x.test"));
      const items = within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent);
      expect(items).toEqual(["Reset code", "Reset sign-in", "Disable"]);
    });

    it("the first action is inline when none is marked primary", () => {
      render(<RowActions actions={[act("One"), act("Two"), act("Three")]} rowName="r" />);
      expect(screen.getByRole("button", { name: "One: r" })).toBeTruthy();
    });

    it("focus goes into the menu, arrows / Home / End move, Enter runs the item and closes", async () => {
      const list = four();
      render(<RowActions actions={list} rowName="ann" />);
      const more = await moreButton("ann");
      fireEvent.click(more);
      const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(items[1]!, { key: "End" });
      expect(document.activeElement).toBe(items[2]);
      fireEvent.keyDown(items[2]!, { key: "Home" });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.click(items[1]!);
      expect(list[3]!.onSelect).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(more);
    });

    it("Escape closes the menu and puts the focus back on the button", async () => {
      render(<RowActions actions={four()} rowName="ann" />);
      const more = await moreButton("ann");
      fireEvent.click(more);
      fireEvent.keyDown(within(screen.getByRole("menu")).getAllByRole("menuitem")[0]!, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(more);
    });

    it("a disabled item in the menu shows its hint", async () => {
      render(<RowActions actions={[act("A", { primary: true }), act("B", { disabled: true, hint: "Not yet" }), act("C")]} rowName="r" />);
      fireEvent.click(await moreButton("r"));
      const b = screen.getByRole("menuitem", { name: /B/ }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.textContent).toContain("Not yet");
    });

    it("the actions are marked so a click on them never opens the row", () => {
      const { container } = render(<RowActions actions={four()} rowName="ann" />);
      expect(container.querySelector("[data-no-row-click]")).not.toBeNull();
    });
  });
});

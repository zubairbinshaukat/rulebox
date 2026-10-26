import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AppTile,
  Avatar,
  Button,
  Dialog,
  IconButton,
  Input,
  MenuItem,
  MenuList,
  Notice,
  ProgressBar,
  SegmentedControl,
  Slider,
  Switch,
  Tabs,
  TitleBar,
} from "@rulebox/ui";

import { expectNoAxeViolations } from "./axe";

describe("IconButton", () => {
  it("is named by its label, and is a toggle only when told to be", () => {
    render(
      <>
        <IconButton label="Refresh">x</IconButton>
        <IconButton label="Bold" active={false}>x</IconButton>
        <IconButton label="Italic" active>x</IconButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("aria-pressed")).toBe(false);
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Italic" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Avatar", () => {
  it("is an image with the name, unless the name is written next to it", async () => {
    const { container } = render(
      <>
        <Avatar name="Maya Chen" />
        <Avatar name="Sam Lee" decorative />
      </>,
    );
    expect(screen.getByRole("img", { name: "Maya Chen" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Sam Lee" })).toBeNull();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    await expectNoAxeViolations(container);
  });
});

describe("Dialog", () => {
  function Host({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open it</button>
        <Dialog
          open={open}
          title="Delete the file?"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          role="alertdialog"
        >
          <p>This cannot be undone.</p>
          <Button variant="ghost">Cancel</Button>
          <Button>Delete</Button>
        </Dialog>
      </>
    );
  }

  it("is a labelled, described, modal dialog with no axe violations", async () => {
    const user = userEvent.setup();
    render(<Host onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete the file?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dialog).getByText("This cannot be undone.")).toBeTruthy();
    await expectNoAxeViolations();
  });

  it("takes the focus, keeps Tab inside, and gives the focus back on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const del = screen.getByRole("button", { name: "Delete" });
    expect(document.activeElement).toBe(cancel);

    await user.tab();
    expect(document.activeElement).toBe(del);
    await user.tab(); // past the last control: back to the first, not out of the dialog
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true }); // before the first: round to the last
    expect(document.activeElement).toBe(del);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("Tabs", () => {
  function Host() {
    const [value, setValue] = useState("a");
    const [closed, setClosed] = useState<string[]>([]);
    const tabs = [
      { id: "a", label: "Alpha", closable: true },
      { id: "b", label: "Beta", closable: true },
      { id: "c", label: "Gamma" },
    ].filter((tab) => !closed.includes(tab.id));
    return (
      <Tabs tabs={tabs} value={value} onChange={setValue} onClose={(id) => setClosed((c) => [...c, id])} aria-label="Pages">
        <p>Panel for {value}</p>
      </Tabs>
    );
  }

  it("has the tab roles, one tab stop, and a panel named by the selected tab", async () => {
    const { container } = render(<Host />);
    const tablist = screen.getByRole("tablist", { name: "Pages" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole("tabpanel", { name: "Alpha" });
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);
    await expectNoAxeViolations(container);
  });

  it("moves the focus and the selection with the arrow keys, Home and End", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const [alpha, beta, gamma] = screen.getAllByRole("tab");
    alpha!.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(beta);
    expect(beta!.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(gamma);
    await user.keyboard("{ArrowRight}"); // wraps
    expect(document.activeElement).toBe(alpha);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(gamma);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(alpha);
  });

  it("closes the focused tab with Delete (the close button is for the mouse, not part of the tab list)", async () => {
    const user = userEvent.setup();
    render(<Host />);
    expect(screen.queryByRole("button", { name: /Close/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-keyshortcuts")).toBe("Delete");
    expect(screen.getByRole("tab", { name: "Gamma" }).hasAttribute("aria-keyshortcuts")).toBe(false);
    screen.getByRole("tab", { name: "Alpha" }).focus();
    await user.keyboard("{Delete}");
    expect(screen.queryByRole("tab", { name: "Alpha" })).toBeNull();
  });
});

describe("SegmentedControl", () => {
  it("is a radio group where the arrow keys move the focus and the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Host() {
      const [value, setValue] = useState<"list" | "grid">("list");
      return (
        <SegmentedControl
          aria-label="View"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          options={[
            { value: "list", label: "List" },
            { value: "grid", label: "Grid" },
          ]}
        />
      );
    }
    const { container } = render(<Host />);
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    const list = screen.getByRole("radio", { name: "List" });
    const grid = screen.getByRole("radio", { name: "Grid" });
    expect([list.tabIndex, grid.tabIndex]).toEqual([0, -1]);
    list.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(grid);
    expect(grid.getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith("grid");
    await expectNoAxeViolations(container);
  });
});

describe("MenuList", () => {
  it("walks the items with the arrow keys, wraps, and skips disabled ones", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(
      <MenuList aria-label="Actions">
        <MenuItem onSelect={onSelect}>Open</MenuItem>
        <MenuItem disabled>Locked</MenuItem>
        <MenuItem danger>Delete</MenuItem>
      </MenuList>,
    );
    const open = screen.getByRole("menuitem", { name: "Open" });
    const del = screen.getByRole("menuitem", { name: "Delete" });
    open.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(del);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(open);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(del);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(open);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    await expectNoAxeViolations(container);
  });
});

describe("Notice", () => {
  it("interrupts for a problem, waits for the rest, and says the tone in words", async () => {
    const { container } = render(
      <>
        <Notice tone="danger" title="Could not save" detail="The disk is full." onDismiss={() => undefined} />
        <Notice tone="warning" title="Almost full" />
        <Notice tone="success" title="Saved" />
        <Notice tone="neutral" title="FYI" />
      </>,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getAllByRole("alert")[0]!.textContent).toContain("Error: Could not save");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe("ProgressBar", () => {
  it("has a name, a value, and the detail as its text", async () => {
    const { container } = render(
      <>
        <ProgressBar label="Maya" detail="3.1 of 10 GB" value={31} />
        <ProgressBar name="Storage" value={85} />
      </>,
    );
    expect(screen.getByRole("progressbar", { name: "Maya" }).getAttribute("aria-valuetext")).toBe("3.1 of 10 GB");
    expect(screen.getByRole("progressbar", { name: "Storage" }).getAttribute("aria-valuenow")).toBe("85");
    await expectNoAxeViolations(container);
  });
});

describe("AppTile", () => {
  it("says the open state and the new count in words, not by a dot and a badge only", async () => {
    const { container } = render(<AppTile name="Mail" description="Your inbox" running badge={3} />);
    const tile = screen.getByRole("button");
    expect(tile.textContent).toContain("Mail");
    expect(tile.textContent).toContain(", open");
    expect(tile.textContent).toContain(", 3 new");
    await expectNoAxeViolations(container);
  });
});

describe("Switch, Slider, Input, TitleBar", () => {
  it("have names and no axe violations", async () => {
    const onMinimize = vi.fn();
    const { container } = render(
      <>
        <TitleBar title="Files" onMinimize={onMinimize} onMaximize={() => undefined} onClose={() => undefined} />
        <Switch label="Kiosk mode" checked onChange={() => undefined} />
        <Slider label="Volume" value={40} onChange={() => undefined} />
        <Input aria-label="Search" />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Kiosk mode" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
    for (const name of ["Minimize", "Maximize", "Close"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // The window title's letter badge is decoration.
    expect(container.querySelector(".rb-titlebar__icon")?.getAttribute("aria-hidden")).toBe("true");
    await expectNoAxeViolations(container);
  });
});

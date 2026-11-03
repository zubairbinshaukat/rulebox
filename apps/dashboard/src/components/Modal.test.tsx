import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DataTable } from "./DataTable";
import { Modal } from "./Modal";

describe("Modal is a page-level dialog", () => {
  // Regression: the demo controls opened from the top bar (`.dash-top` has a backdrop-filter, which
  // makes it the containing block of `position: fixed` children) and were clipped at the bar's edge.
  it("renders into document.body, not inside the header that opened it", () => {
    render(
      <header className="dash-top" data-testid="bar">
        <Modal open title="Demo controls" onClose={() => undefined}>
          <button>Lose connection</button>
        </Modal>
      </header>,
    );
    const dialog = screen.getByRole("dialog", { name: "Demo controls" });
    expect(screen.getByTestId("bar").contains(dialog)).toBe(false);
    const backdrop = dialog.parentElement!;
    expect(backdrop.className).toContain("rb-dialog-backdrop");
    expect(backdrop.parentElement).toBe(document.body);
  });

  it("still traps focus, closes on Escape and returns focus to the opener", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <header>
          <button onClick={() => setOpen(true)}>open</button>
          <Modal open={open} title="T" onClose={() => setOpen(false)} actions={<button onClick={() => setOpen(false)}>Done</button>}>
            <button>inside</button>
          </Modal>
        </header>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    const inside = screen.getByRole("button", { name: "inside" });
    expect(document.activeElement).toBe(inside);
    const done = screen.getByRole("button", { name: "Done" });
    done.focus();
    fireEvent.keyDown(done, { key: "Tab" });
    expect(document.activeElement).toBe(inside);
    fireEvent.keyDown(inside, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("submits its form (events bubble through the portal)", () => {
    const onSubmit = vi.fn();
    render(
      <Modal open title="T" onClose={() => undefined} onSubmit={onSubmit}>
        <button type="submit">Save</button>
      </Modal>,
    );
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a click inside a dialog opened from a table cell does not click the row", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        caption="T"
        columns={[{ key: "a", header: "A", cell: () => <Modal open title="Sure?" onClose={() => undefined}><p>Really delete?</p></Modal> }]}
        rows={[{ id: "1" }]}
        getKey={(r) => r.id}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(screen.getByText("Really delete?"));
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

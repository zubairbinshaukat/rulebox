import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppError } from "../lib/errors";
import { VIEW_KEY } from "../lib/viewMode";
import { EmptyState } from "./EmptyState";
import { DataTable, type Column, type DataTableProps } from "./DataTable";

interface Row {
  id: string;
  name: string;
  count: number;
}
const ROWS: Row[] = [
  { id: "a", name: "Alpha", count: 3 },
  { id: "b", name: "Bravo", count: 1 },
];

const cols: Column<Row>[] = [
  {
    key: "name",
    header: "Name",
    primary: true,
    sortable: true,
    cell: (r) => (
      <a href={`/x/${r.id}`} className="dash-link dash-link--plain" onClick={(e) => e.preventDefault()}>
        {r.name}
      </a>
    ),
  },
  { key: "count", header: "Count", numeric: true, sortable: true, sortDefaultDir: "desc", cell: (r) => r.count },
  {
    key: "act",
    header: "Actions",
    actions: true,
    cell: (r) => (
      <>
        <button type="button">Remove {r.name}</button>
        <span data-no-row-click="true">Note {r.name}</span>
      </>
    ),
  },
];

function show(over: Partial<DataTableProps<Row>> = {}) {
  const props: DataTableProps<Row> = { caption: "Things", columns: cols, rows: ROWS, getKey: (r) => r.id, ...over };
  return render(<DataTable {...props} />);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-view");
});

describe("DataTable: structure", () => {
  it("keeps the semantic table: caption, column headers and one row per item", () => {
    show();
    const table = screen.getByRole("table", { name: "Things" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Count", "Actions"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("makes the table a focusable, labelled region in table view (it scrolls sideways at any width)", () => {
    show();
    const region = screen.getByRole("region", { name: "Things" });
    expect(region.tabIndex).toBe(0);
    expect(region.className).toContain("dash-table-wrap");
  });

  it("in cards view the wrapper is no scroll region; stack={false} stays a table", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    const { unmount } = show();
    expect(screen.queryByRole("region", { name: "Things" })).toBeNull();
    expect(screen.getByRole("table", { name: "Things" }).className).toContain("dash-table--stack");
    unmount();
    show({ stack: false });
    expect(screen.getByRole("region", { name: "Things" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Things" }).className).not.toContain("dash-table--stack");
  });

  it("greys dim rows and gives the cells their labels for the cards view", () => {
    show({ isDim: (r) => r.id === "b" });
    const rows = screen.getAllByRole("row");
    expect(rows[1]!.getAttribute("data-dim")).toBeNull();
    expect(rows[2]!.getAttribute("data-dim")).toBe("true");
    expect(within(rows[1]!).getAllByRole("cell")[1]!.getAttribute("data-label")).toBe("Count");
  });

  it("only scrolls rows inside the table (sticky header) when asked with maxHeight", () => {
    show({ maxHeight: "60vh" });
    const region = screen.getByRole("region", { name: "Things" });
    expect(region.className).toContain("dash-table-wrap--scroll");
    expect(region.style.maxHeight).toBe("60vh");
  });
});

describe("DataTable: short cells and long text", () => {
  const cellsOf = (row: number) => within(screen.getAllByRole("row")[row]!).getAllByRole("cell");

  it("numeric and action columns never wrap by themselves; a plain column wraps unless it says nowrap", () => {
    show();
    const [name, count, actions] = cellsOf(1);
    expect(name!.className).not.toContain("dash-cell--nowrap");
    expect(count!.className).toContain("dash-cell--nowrap");
    expect(actions!.className).toContain("dash-cell--nowrap");
  });

  it("nowrap on a column keeps its cells on one line (dates, states, counts like '0 of 1 used')", () => {
    const withNowrap: Column<Row>[] = [
      { key: "n", header: "N", primary: true, cell: (r) => r.name },
      { key: "u", header: "Used", nowrap: true, cell: () => "0 of 1 used" },
    ];
    show({ columns: withNowrap });
    expect(cellsOf(1)[0]!.className).not.toContain("dash-cell--nowrap");
    expect(cellsOf(1)[1]!.className).toContain("dash-cell--nowrap");
  });

  it("the name column takes the rest of the width only when every other column is short", () => {
    const table = () => screen.getByRole("table", { name: "Things" });
    const short: Column<Row>[] = [
      { key: "n", header: "N", primary: true, cell: (r) => r.name },
      { key: "c", header: "C", numeric: true, cell: (r) => r.count },
      { key: "t", header: "T", truncate: 20, cell: (r) => r.name },
    ];
    const { unmount } = show({ columns: short });
    expect(table().className).toContain("dash-table--fit");
    unmount();
    show({ columns: [...short, { key: "free", header: "Free", cell: (r) => r.name }] });
    expect(table().className).not.toContain("dash-table--fit");
  });

  it("truncate cuts after that many characters (32 for true), keeps the full text and offers it as the title", () => {
    const long = "A very long free text that goes on and on and on and on";
    const cols2: Column<Row>[] = [
      { key: "n", header: "N", primary: true, cell: (r) => r.name },
      { key: "a", header: "A", truncate: 12, cell: () => long },
      { key: "b", header: "B", truncate: true, cell: () => long },
    ];
    show({ columns: cols2 });
    const [, a, b] = cellsOf(1);
    const spanA = a!.querySelector<HTMLElement>(".dash-cell-trunc")!;
    const spanB = b!.querySelector<HTMLElement>(".dash-cell-trunc")!;
    expect(spanA.style.maxWidth).toBe("12ch");
    expect(spanB.style.maxWidth).toBe("32ch");
    expect(spanA.textContent).toBe(long);
    expect(spanA.title).toBe(long);
    // A truncating column cannot be squeezed either.
    expect(a!.className).toContain("dash-cell--nowrap");
  });

  it("gives the title of a truncated element cell only when the text is really cut", () => {
    const cols2: Column<Row>[] = [{ key: "a", header: "A", truncate: 10, cell: (r) => <b>{r.name}</b> }];
    show({ columns: cols2 });
    const span = cellsOf(1)[0]!.querySelector<HTMLElement>(".dash-cell-trunc")!;
    expect(span.title).toBe("");
    Object.defineProperty(span, "scrollWidth", { configurable: true, value: 300 });
    Object.defineProperty(span, "clientWidth", { configurable: true, value: 100 });
    fireEvent.mouseEnter(span);
    expect(span.title).toBe("Alpha");
  });

  it("in cards view the one-line table rules stay off", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    show();
    expect(screen.getByRole("table", { name: "Things" }).className).not.toContain("dash-table--fit");
    expect(cellsOf(1)[1]!.className).not.toContain("dash-cell--nowrap");
  });
});

describe("DataTable: sorting", () => {
  it("only sortable columns get a button and aria-sort; the rest stay plain headers", () => {
    show({ sort: { key: "name", dir: "asc" }, onSortChange: vi.fn() });
    const [name, count, actions] = screen.getAllByRole("columnheader");
    expect(name!.getAttribute("aria-sort")).toBe("ascending");
    expect(count!.getAttribute("aria-sort")).toBe("none");
    expect(actions!.getAttribute("aria-sort")).toBeNull();
    expect(within(name!).getByRole("button", { name: "Name" })).toBeTruthy();
    expect(within(actions!).queryByRole("button")).toBeNull();
  });

  it("shows descending, and no sort buttons without onSortChange", () => {
    const { unmount } = show({ sort: { key: "count", dir: "desc" }, onSortChange: vi.fn() });
    expect(screen.getAllByRole("columnheader")[1]!.getAttribute("aria-sort")).toBe("descending");
    unmount();
    show();
    expect(screen.queryByRole("button", { name: "Name" })).toBeNull();
    expect(screen.getAllByRole("columnheader")[0]!.getAttribute("aria-sort")).toBeNull();
  });

  it("clicking the sorted column flips the direction; a new column starts with its default direction", () => {
    const onSortChange = vi.fn();
    show({ sort: { key: "name", dir: "asc" }, onSortChange });
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", dir: "desc" });
    fireEvent.click(screen.getByRole("button", { name: "Count" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "count", dir: "desc" });
  });

  it("is a real button: reachable by Tab and operated by the keyboard (Enter and Space click it)", () => {
    const onSortChange = vi.fn();
    show({ onSortChange });
    const btn = screen.getByRole("button", { name: "Name" }) as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.type).toBe("button");
    expect(btn.tabIndex).toBe(0);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn); // what the browser does for Enter / Space on a button
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", dir: "asc" });
  });

  it("offers a sort select in the toolbar for the cards view", () => {
    const onSortChange = vi.fn();
    show({ framed: true, sort: { key: "name", dir: "asc" }, onSortChange });
    const select = screen.getByLabelText("Sort by") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["name:asc", "name:desc", "count:asc", "count:desc"]);
    fireEvent.change(select, { target: { value: "count:desc" } });
    expect(onSortChange).toHaveBeenCalledWith({ key: "count", dir: "desc" });
  });
});

describe("DataTable: whole-row click", () => {
  it("clicking anywhere in the row opens it", () => {
    const onRowClick = vi.fn();
    show({ onRowClick });
    const row = screen.getAllByRole("row")[1]!;
    expect(row.getAttribute("data-clickable")).toBe("true");
    fireEvent.click(within(row).getByText("3"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("does not fire for the link, a button, or an element marked data-no-row-click", () => {
    const onRowClick = vi.fn();
    show({ onRowClick });
    fireEvent.click(screen.getByRole("link", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
    fireEvent.click(screen.getByText("Note Alpha"));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("leaves modified clicks (ctrl, shift) and text selection alone", () => {
    const onRowClick = vi.fn();
    show({ onRowClick });
    const cell = screen.getAllByRole("row")[1]!.querySelectorAll("td")[1]!;
    fireEvent.click(cell, { ctrlKey: true });
    fireEvent.click(cell, { metaKey: true });
    expect(onRowClick).not.toHaveBeenCalled();
    const sel = vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false, toString: () => "3" } as unknown as Selection);
    fireEvent.click(cell);
    sel.mockRestore();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("rows are not clickable without onRowClick", () => {
    show();
    expect(screen.getAllByRole("row")[1]!.getAttribute("data-clickable")).toBeNull();
  });

  it("calls the latest handler even though the memoized rows did not re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = show({ onRowClick: first });
    rerender(<DataTable caption="Things" columns={cols} rows={ROWS} getKey={(r) => r.id} onRowClick={second} />);
    fireEvent.click(within(screen.getAllByRole("row")[2]!).getByText("1"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(ROWS[1]);
  });

  it("memoized rows render once per change of their own props", () => {
    const cell = vi.fn((r: Row) => r.name);
    const memoCols: Column<Row>[] = [{ key: "n", header: "N", cell }];
    const { rerender } = render(<DataTable caption="t" columns={memoCols} rows={ROWS} getKey={(r) => r.id} />);
    expect(cell).toHaveBeenCalledTimes(2);
    rerender(<DataTable caption="t" columns={memoCols} rows={ROWS} getKey={(r) => r.id} onRowClick={() => undefined} />);
    // A row gets a click wrapper only now: both re-render once, then stay quiet for an inline handler.
    const after = cell.mock.calls.length;
    rerender(<DataTable caption="t" columns={memoCols} rows={ROWS} getKey={(r) => r.id} onRowClick={() => undefined} />);
    expect(cell.mock.calls.length).toBe(after);
  });
});

describe("DataTable: states", () => {
  it("loading shows skeleton rows and no table", () => {
    show({ state: "loading" });
    expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("empty shows the given EmptyState, or a default one", () => {
    const { unmount } = show({ state: "empty", rows: [], empty: <EmptyState title="No devices yet" /> });
    expect(screen.getByText("No devices yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    unmount();
    show({ state: "empty", rows: [] });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
  });

  it("error shows the notice with Try again", () => {
    const onRetry = vi.fn();
    show({ state: "error", error: new AppError({ code: "rate_limited" }), onRetry });
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("busy keeps the old rows and announces it", () => {
    show({ busy: true });
    expect(screen.getByRole("region", { name: "Things" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("the footer shows with rows, not while loading, empty or failed", () => {
    const footer = <p>pager here</p>;
    const { unmount } = show({ footer });
    expect(screen.getByText("pager here")).toBeTruthy();
    unmount();
    show({ footer, state: "loading" });
    expect(screen.queryByText("pager here")).toBeNull();
  });
});

describe("DataTable: toolbar and view switch", () => {
  it("framed tables draw their own card and the Table | Cards switch next to the toolbar", () => {
    const { container } = show({ framed: true, toolbar: <input aria-label="Find" /> });
    expect(container.querySelector(".dash-dt__surface.dash-card")).not.toBeNull();
    expect(screen.getByLabelText("Find")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
  });

  it("the switch changes the one global view (and the attribute the CSS reads)", () => {
    show({ framed: true });
    expect((screen.getByRole("radio", { name: "Table" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    expect(document.documentElement.getAttribute("data-view")).toBe("cards");
    expect(localStorage.getItem(VIEW_KEY)).toBe("cards");
    expect(screen.getByRole("radio", { name: "Cards" }).getAttribute("aria-checked")).toBe("true");
    // The wrapper is no scroll region any more.
    expect(screen.queryByRole("region", { name: "Things" })).toBeNull();
  });

  it("the legacy layout (inside the screen's own Card) gets no toolbar and no switch", () => {
    const { container } = show();
    expect(container.querySelector(".dash-dt__toolbar")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("stack={false} shows no switch (the table makes no sense as cards)", () => {
    show({ framed: true, stack: false });
    expect(screen.queryByRole("radiogroup", { name: "View" })).toBeNull();
  });
});

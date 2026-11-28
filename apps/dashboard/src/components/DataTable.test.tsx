import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppError } from "../lib/errors";
import { VIEW_KEY } from "../lib/viewMode";
import { optionLabels, pickOption, selectedText } from "../test/select";
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

  it("in cards view the list is a list named by the caption with one item per row and no table; stack={false} stays a table", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    const { unmount } = show();
    expect(screen.queryByRole("region", { name: "Things" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Things" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    unmount();
    show({ stack: false });
    expect(screen.getByRole("region", { name: "Things" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Things" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Things" })).toBeNull();
  });

  it("greys dim rows", () => {
    show({ isDim: (r) => r.id === "b" });
    const rows = screen.getAllByRole("row");
    expect(rows[1]!.getAttribute("data-dim")).toBeNull();
    expect(rows[2]!.getAttribute("data-dim")).toBe("true");
  });

  it("cards show facts as a label above the value (dt / dd), with the header or cardLabel as the label", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    show({ columns: [cols[0]!, { ...cols[1]!, cardLabel: "How many" }] });
    const [first] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("How many").tagName).toBe("DT");
    expect(within(first!).getByText("3").closest("dd")).not.toBeNull();
    // The name is the title and the real link.
    expect(within(first!).getByRole("link", { name: "Alpha" })).toBeTruthy();
  });

  it("card-only columns (table: false) are not in the table but are in the cards", () => {
    const withExtra: Column<Row>[] = [...cols, { key: "x", header: "Extra", table: false, card: "detail", cell: () => "only on cards" }];
    const { unmount } = show({ columns: withExtra });
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Count", "Actions"]);
    expect(screen.queryByText("only on cards")).toBeNull();
    unmount();
    localStorage.setItem(VIEW_KEY, "cards");
    show({ columns: withExtra });
    expect(screen.getAllByText("only on cards")).toHaveLength(2);
  });

  it("a rowActions column draws the same buttons in the table cell and the card footer", () => {
    const onRevoke = vi.fn();
    const withActions: Column<Row>[] = [
      cols[0]!,
      { key: "act", header: "Actions", actions: true, cell: () => null, rowActions: (r) => [{ label: "Revoke", danger: true, onSelect: () => onRevoke(r.id) }] },
    ];
    const { unmount } = show({ columns: withActions, rowLabel: (r) => r.name });
    fireEvent.click(screen.getByRole("button", { name: "Revoke: Alpha" }));
    expect(onRevoke).toHaveBeenCalledWith("a");
    unmount();
    localStorage.setItem(VIEW_KEY, "cards");
    show({ columns: withActions, rowLabel: (r) => r.name });
    fireEvent.click(screen.getByRole("button", { name: "Revoke: Bravo" }));
    expect(onRevoke).toHaveBeenLastCalledWith("b");
  });

  it("every row of a table gets the type class of its column on the header and the cell", () => {
    const typed: Column<Row>[] = [
      { key: "n", header: "N", primary: true, cell: (r) => r.name },
      { key: "d", header: "D", type: "date", cell: () => "4 minutes ago" },
      { key: "t", header: "T", type: "text", cell: () => "some free text" },
      { key: "m", header: "M", type: "mono", cell: () => "22631" },
    ];
    show({ columns: typed });
    const heads = screen.getAllByRole("columnheader").map((h) => h.className);
    expect(heads[0]).toContain("dash-col--name");
    expect(heads[1]).toContain("dash-col--date");
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    expect(cells[1]!.className).toContain("dash-cell--nowrap");
    expect(cells[2]!.className).not.toContain("dash-cell--nowrap");
    expect(cells[3]!.className).toContain("dash-col--mono");
    // A long string in a capped cell is cut by the shared Truncate box at the type's cap.
    expect(cells[2]!.querySelector<HTMLElement>(".dash-truncate-box")!.style.maxWidth).toBe("360px");
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

  it("truncate (legacy) cuts after that many characters (32 for true) and keeps the full text, with no title attribute", () => {
    const long = "A very long free text that goes on and on and on and on";
    const cols2: Column<Row>[] = [
      { key: "n", header: "N", primary: true, cell: (r) => r.name },
      { key: "a", header: "A", truncate: 12, cell: () => long },
      { key: "b", header: "B", truncate: true, cell: () => long },
    ];
    show({ columns: cols2 });
    const [, a, b] = cellsOf(1);
    const boxA = a!.querySelector<HTMLElement>(".dash-truncate-box")!;
    const boxB = b!.querySelector<HTMLElement>(".dash-truncate-box")!;
    expect(boxA.style.maxWidth).toBe("12ch");
    expect(boxB.style.maxWidth).toBe("32ch");
    expect(boxA.textContent).toBe(long);
    expect(boxA.hasAttribute("title")).toBe(false);
    // A truncating column cannot be squeezed either.
    expect(a!.className).toContain("dash-cell--nowrap");
  });

  it("a name cell that is a plain string gets the shared tooltip box, capped at 280 px", () => {
    show({ columns: [{ key: "n", header: "N", primary: true, cell: (r) => r.name }] });
    const box = cellsOf(1)[0]!.querySelector<HTMLElement>(".dash-truncate-box")!;
    expect(box.style.maxWidth).toBe("280px");
    expect(box.textContent).toBe("Alpha");
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

  it("offers the custom sort select in the toolbar for the cards view only, in plain words", () => {
    const onSortChange = vi.fn();
    const { unmount } = show({ framed: true, sort: { key: "name", dir: "asc" }, onSortChange });
    expect(screen.queryByLabelText("Sort by")).toBeNull();
    unmount();
    localStorage.setItem(VIEW_KEY, "cards");
    show({ framed: true, sort: { key: "name", dir: "asc" }, onSortChange });
    expect(selectedText("Sort by")).toBe("Name: A to Z");
    expect(optionLabels("Sort by")).toEqual(["Name: A to Z", "Name: Z to A", "Count: most first", "Count: fewest first"]);
    pickOption("Sort by", "Count: fewest first");
    expect(onSortChange).toHaveBeenCalledWith({ key: "count", dir: "asc" });
  });

  it("lists a default order that has no column first, so the select can show the current order", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    show({ framed: true, sort: { key: "added", dir: "desc" }, onSortChange: vi.fn(), defaultSort: { key: "added", dir: "desc", label: "Newest first" } });
    expect(selectedText("Sort by")).toBe("Newest first");
    expect(optionLabels("Sort by")[0]).toBe("Newest first");
  });

  it("while a search orders by relevance the sort select is disabled and says so", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    show({ framed: true, sortNote: "Best matches first" });
    const trigger = screen.getByLabelText("Sort by") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toBe("Best matches first");
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
    // The wrapper is no scroll region any more: the rows are a list of cards.
    expect(screen.queryByRole("region", { name: "Things" })).toBeNull();
    expect(screen.getByRole("list", { name: "Things" })).toBeTruthy();
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

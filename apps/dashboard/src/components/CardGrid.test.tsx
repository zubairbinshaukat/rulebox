import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CardGrid, type CardGridProps } from "./CardGrid";
import type { Column } from "./DataTable";

interface Row {
  id: string;
  name: string;
  group: string | null;
  online: boolean;
  kiosk: string;
  policy: string;
  windows: string;
  note: string;
}
const ROWS: Row[] = [
  { id: "a", name: "Reception PC", group: "Front desk", online: true, kiosk: "Applied", policy: "Up to date", windows: "22631", note: "" },
  { id: "b", name: "Kitchen tablet", group: null, online: false, kiosk: "", policy: "", windows: "19045", note: "Could not reach the PC for two days" },
];

const columns: Column<Row>[] = [
  { key: "name", header: "Name", primary: true, cell: (r) => <a href={`/d/${r.id}`} onClick={(e) => e.preventDefault()}>{r.name}</a>, cardSub: (r) => r.group },
  { key: "online", header: "Status", card: "status", cell: (r) => (r.online ? "Online" : "Offline") },
  { key: "kiosk", header: "Kiosk", card: "status", isEmpty: (r) => !r.kiosk, cell: (r) => r.kiosk },
  { key: "policy", header: "Policy", isEmpty: (r) => !r.policy, cell: (r) => r.policy },
  { key: "windows", header: "Windows", card: "detail", cardLabel: "Windows build", cell: (r) => r.windows },
  { key: "note", header: "Problem", type: "text", card: "detail", isEmpty: (r) => !r.note, cell: (r) => r.note },
  {
    key: "act",
    header: "Actions",
    actions: true,
    cell: () => null,
    isEmpty: (r) => r.id === "a",
    rowActions: (r) => [{ label: "Retry", onSelect: () => undefined, disabled: false }, { label: "Remove", danger: true, onSelect: () => undefined, hint: r.name }],
  },
];

function show(over: Partial<CardGridProps<Row>> = {}) {
  const props: CardGridProps<Row> = { caption: "PCs", columns, rows: ROWS, getKey: (r) => r.id, rowLabel: (r) => r.name, ...over };
  return render(<CardGrid {...props} />);
}

describe("CardGrid", () => {
  it("is a list named by the caption with one article per record, named by its title", () => {
    show();
    const list = screen.getByRole("list", { name: "PCs" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("article", { name: "Reception PC" })).toBeTruthy();
    expect(screen.getByRole("article", { name: /Kitchen tablet/ })).toBeTruthy();
  });

  it("puts title, subtitle, status, facts, details and actions in their slots", () => {
    show();
    const card = screen.getByRole("article", { name: "Reception PC" });
    expect(card.querySelector(".dash-rcard__title a")!.textContent).toBe("Reception PC");
    expect(card.querySelector(".dash-rcard__sub")!.textContent).toBe("Front desk");
    expect(card.querySelector(".dash-rcard__status")!.textContent).toBe("OnlineApplied");
    expect(within(card).getByText("Policy").tagName).toBe("DT");
    expect(within(card).getByText("Up to date").closest("dd")).not.toBeNull();
    expect(card.querySelector(".dash-rcard__details")!.textContent).toBe("Windows build 22631");
  });

  it("an empty fact shows a dash; empty status, subtitle, details and actions render nothing", () => {
    show();
    const card = screen.getByRole("article", { name: /Kitchen tablet/ });
    const policy = within(card).getByText("Policy").closest("div")!;
    expect(policy.querySelector("dd")!.textContent).toBe("—");
    // The kiosk status is empty: only the Offline badge is drawn.
    expect(card.querySelectorAll(".dash-rcard__badge")).toHaveLength(1);
    const first = screen.getByRole("article", { name: "Reception PC" });
    expect(first.querySelector(".dash-rcard__text")).toBeNull();
    // No actions on the first card (isEmpty), a footer on the second.
    expect(first.querySelector(".dash-rcard__actions")).toBeNull();
    expect(card.querySelector(".dash-rcard__actions")).not.toBeNull();
    // A `text` detail gets its own block with its label.
    expect(card.querySelector(".dash-rcard__text")!.textContent).toBe("ProblemCould not reach the PC for two days");
  });

  it("the actions use the record's name and are not part of the row click", () => {
    const onActivate = vi.fn();
    show({ onActivate });
    fireEvent.click(screen.getByRole("button", { name: "Retry: Kitchen tablet" }));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("the whole card opens the record; links, buttons, selected text and ctrl-clicks do not", () => {
    const onActivate = vi.fn();
    show({ onActivate });
    const card = screen.getByRole("article", { name: "Reception PC" });
    fireEvent.click(within(card).getByText("Up to date"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenLastCalledWith(ROWS[0]);
    fireEvent.click(within(card).getByRole("link", { name: "Reception PC" }));
    fireEvent.click(within(card).getByText("Up to date"), { ctrlKey: true });
    const sel = vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false, toString: () => "Up" } as unknown as Selection);
    fireEvent.click(within(card).getByText("Up to date"));
    sel.mockRestore();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(card.getAttribute("data-clickable")).toBe("true");
  });

  it("is keyboard friendly: the card is no tab stop, Tab goes title link, actions, next card's link", async () => {
    const user = userEvent.setup();
    show({ onActivate: vi.fn() });
    const cards = screen.getAllByRole("article");
    expect(cards.every((c) => !c.hasAttribute("tabindex"))).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Reception PC" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Kitchen tablet" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry: Kitchen tablet" }));
  });

  it("dim cards are marked, busy lists say so, a flat list has flat tiles", () => {
    const { container } = show({ isDim: (r) => r.id === "b", busy: true, flat: true });
    expect(screen.getByRole("article", { name: "Reception PC" }).hasAttribute("data-dim")).toBe(false);
    expect(screen.getByRole("article", { name: /Kitchen tablet/ }).getAttribute("data-dim")).toBe("true");
    const list = container.querySelector(".dash-cards")!;
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(list.getAttribute("data-flat")).toBe("true");
  });

  it("a card re-renders only when its own row changes", () => {
    const cell = vi.fn((r: Row) => r.name);
    const cols: Column<Row>[] = [{ key: "n", header: "N", primary: true, cell }];
    const props = { caption: "t", columns: cols, getKey: (r: Row) => r.id };
    const { rerender } = render(<CardGrid {...props} rows={ROWS} />);
    expect(cell).toHaveBeenCalledTimes(2);
    rerender(<CardGrid {...props} rows={[ROWS[0]!, { ...ROWS[1]!, name: "Kitchen tablet 2" }]} />);
    expect(cell).toHaveBeenCalledTimes(3);
  });
});

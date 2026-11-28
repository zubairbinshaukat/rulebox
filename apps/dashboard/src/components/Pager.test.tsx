import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { optionLabels, pickOption, selectedText } from "../test/select";
import { Pager, type PagerProps } from "./Pager";

function show(over: Partial<PagerProps> = {}) {
  const props: PagerProps = {
    page: 1,
    pageSize: 10,
    total: 147,
    reachablePages: new Set([1, 2, 15]),
    onPage: vi.fn(),
    onPageSize: vi.fn(),
    hasNext: true,
    ...over,
  };
  render(<Pager {...props} />);
  return props;
}

const nav = () => screen.getByRole("navigation", { name: "Pagination" });

describe("Pager", () => {
  it("says how many records and which page, with the total known", () => {
    show();
    expect(screen.getByRole("status").textContent?.replace(/\s/g, " ")).toBe("147 records · Page 1 of 15");
  });

  it("says only 'Page N' when there is no total, and offers no last page", () => {
    show({ total: null, page: 3, reachablePages: new Set([1, 2, 3, 4]) });
    expect(screen.getByRole("status").textContent?.replace(/\s/g, " ")).toBe("Page 3");
    const buttons = within(nav()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(buttons).toEqual(["Previous page", "Page 1", "Page 2", "Page 3", "Page 4", "Next page"]);
  });

  it("draws only reachable pages as buttons, with an ellipsis between non-adjacent ones", () => {
    show();
    const buttons = within(nav()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(buttons).toEqual(["Previous page", "Page 1", "Page 2", "Page 15", "Next page"]);
    expect(nav().querySelectorAll(".dash-pager__gap")).toHaveLength(1);
    // Page 7 is not reachable: no button for it.
    expect(screen.queryByRole("button", { name: "Page 7" })).toBeNull();
  });

  it("marks the current page with aria-current and fills it as the accent button", () => {
    show({ page: 2, reachablePages: new Set([1, 2, 3, 15]) });
    const current = within(nav()).getByRole("button", { name: "Page 2" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(within(nav()).getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBeNull();
  });

  it("opens the page that was clicked, Previous and Next", () => {
    const p = show({ page: 2, reachablePages: new Set([1, 2, 3, 15]) });
    fireEvent.click(screen.getByRole("button", { name: "Page 15" }));
    expect(p.onPage).toHaveBeenLastCalledWith(15);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(p.onPage).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(p.onPage).toHaveBeenLastCalledWith(3);
    // Clicking the current page does nothing.
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(p.onPage).toHaveBeenCalledTimes(3);
  });

  it("disables Previous on page 1 and Next on the last page, but keeps both", () => {
    show();
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Next on the last page", () => {
    show({ page: 15, hasNext: false, reachablePages: new Set([1, 14, 15]) });
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("without a total, Next follows hasNext", () => {
    show({ total: null, page: 2, hasNext: false, reachablePages: new Set([1, 2]) });
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("changes the rows per page (10, 25, 50) with the custom select", async () => {
    const p = show();
    await screen.findByLabelText("Rows per page"); // the dropdown is a lazy chunk
    expect(optionLabels("Rows per page")).toEqual(["10", "25", "50"]);
    expect(selectedText("Rows per page")).toBe("10");
    pickOption("Rows per page", "25");
    expect(p.onPageSize).toHaveBeenCalledWith(25);
  });

  it("keeps a page size from a stale URL visible", async () => {
    show({ pageSize: 20 });
    await screen.findByLabelText("Rows per page");
    expect(optionLabels("Rows per page")).toEqual(["10", "20", "25", "50"]);
    expect(selectedText("Rows per page")).toBe("20");
  });

  it("one page at the default size shows only how many records there are", () => {
    show({ total: 3, hasNext: false, reachablePages: new Set([1]) });
    expect(screen.getByRole("status").textContent).toBe("3\u00a0records");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByLabelText("Rows per page")).toBeNull();
  });

  it("one page and no total shows nothing at all", () => {
    const { container } = render(<Pager page={1} pageSize={10} total={null} hasNext={false} reachablePages={new Set([1])} onPage={vi.fn()} onPageSize={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("a size other than the default keeps the size select, so the person can go back", async () => {
    show({ total: 3, hasNext: false, pageSize: 25, reachablePages: new Set([1]) });
    expect(await screen.findByLabelText("Rows per page")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();
  });

  it("the summary breaks after the dot, never inside 'Page 1 of 15'", () => {
    show();
    expect(screen.getByRole("status").textContent).toBe("147\u00a0records · Page\u00a01\u00a0of\u00a015");
  });

  it("lays out as three parts the CSS arranges per width: the summary, the page buttons, rows per page", () => {
    show();
    const bar = nav().parentElement!;
    expect(bar.className).toBe("dash-pager");
    expect([...bar.children].map((c) => c.className)).toEqual(["dash-pager__summary", "dash-pager__nav", "dash-pager__size"]);
  });

  it("announces busy while a page loads", () => {
    show({ loading: true });
    expect(nav().getAttribute("aria-busy")).toBe("true");
  });

  it("takes its own words", () => {
    show({ labels: { rowsPerPage: "Zeilen pro Seite", summary: () => "x" } });
    expect(screen.getByLabelText("Zeilen pro Seite")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("x");
  });
});

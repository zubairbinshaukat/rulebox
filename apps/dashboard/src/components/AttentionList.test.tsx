import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { AttentionList, type AttentionItem } from "./AttentionList";

const item = (key: string, tone: AttentionItem["tone"], extra: Partial<AttentionItem> = {}): AttentionItem => ({ key, tone, title: `Title ${key}`, ...extra });

function setup(items: AttentionItem[], props: Partial<Parameters<typeof AttentionList>[0]> = {}) {
  return render(
    <MemoryRouter>
      <AttentionList items={items} label="Needs attention" {...props} />
    </MemoryRouter>,
  );
}

const titles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("AttentionList", () => {
  it("sorts danger, then warning, then info, keeping the given order inside a tone", () => {
    setup([item("i1", "info"), item("w1", "warning"), item("d1", "danger"), item("w2", "warning"), item("d2", "danger")]);
    expect(titles().map((t) => t!.split(": ").pop())).toEqual(["Title d1", "Title d2", "Title w1", "Title w2", "Title i1"]);
  });

  it("is a list with the tone in words before each title, not only in colour", () => {
    setup([item("d", "danger"), item("w", "warning"), item("i", "info")]);
    expect(screen.getByRole("list", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(titles()).toEqual(["Urgent: Title d", "Warning: Title w", "Note: Title i"]);
  });

  it("uses the words it is given for the tones", () => {
    setup([item("d", "danger")], { toneWords: { danger: "Dringend", warning: "w", info: "i" } });
    expect(titles()).toEqual(["Dringend: Title d"]);
  });

  it("shows the first 5 and folds the rest behind Show all (n) / Show fewer", async () => {
    const user = userEvent.setup();
    setup(Array.from({ length: 8 }, (_, i) => item(`w${i}`, "warning")));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    const toggle = screen.getByRole("button", { name: "Show all (8)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("honours `max`, and has no toggle when everything fits", () => {
    const { unmount } = setup([item("a", "info"), item("b", "info"), item("c", "info")], { max: 2 });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show all (3)" })).toBeTruthy();
    unmount();
    setup([item("a", "info"), item("b", "info")], { max: 2 });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("puts the most urgent cards first when it cuts the list", () => {
    const items = [...Array.from({ length: 6 }, (_, i) => item(`i${i}`, "info")), item("late-danger", "danger")];
    setup(items);
    expect(titles()[0]).toBe("Urgent: Title late-danger");
    expect(screen.queryByText(/Title i5/)).toBeNull();
  });

  it("gives each card one action: a link to a page, or a button", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    setup([
      item("a", "danger", { action: { label: "Open Settings", to: "/settings" } }),
      item("b", "warning", { action: { label: "Show", onClick } }),
      item("c", "info"),
    ]);
    const link = screen.getByRole("link", { name: "Open Settings" });
    expect(link.getAttribute("href")).toBe("/settings");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    // Only the first action is the filled one.
    expect(link.className).toContain("rb-btn--primary");
    expect(screen.getByRole("button", { name: "Show" }).className).toContain("rb-btn--ghost");
  });

  it("lets an item say which action is the main one", () => {
    setup([item("a", "danger", { action: { label: "First", to: "/a" } }), item("b", "warning", { action: { label: "Second", to: "/b", primary: true } })]);
    expect(screen.getByRole("link", { name: "First" }).className).toContain("rb-btn--ghost");
    expect(screen.getByRole("link", { name: "Second" }).className).toContain("rb-btn--primary");
  });

  it("shows the body and a custom icon", () => {
    setup([item("a", "info", { body: "Nobody can sign in on them.", icon: <svg data-testid="mine" /> })]);
    expect(screen.getByText("Nobody can sign in on them.")).toBeTruthy();
    expect(within(screen.getByRole("article")).getByTestId("mine")).toBeTruthy();
  });

  it("says what to say when there is nothing to do, or draws nothing", () => {
    const { container, unmount } = setup([], { emptyText: "Everything is fine." });
    expect(screen.getByRole("status").textContent).toBe("Everything is fine.");
    unmount();
    const empty = setup([]);
    expect(empty.container.querySelector(".dash-attn")).toBeNull();
    expect(container).toBeTruthy();
  });
});

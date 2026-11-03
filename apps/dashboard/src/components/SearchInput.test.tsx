import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SearchInput } from "./SearchInput";

const box = () => screen.getByRole("searchbox") as HTMLInputElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });

afterEach(() => vi.useRealTimers());

describe("SearchInput (Enter to search)", () => {
  it("is a search form with a label, and says Press Enter to search", () => {
    render(<SearchInput label="Search devices" onSearch={() => undefined} />);
    expect(screen.getByRole("search")).toBeTruthy();
    expect(screen.getByLabelText("Search devices")).toBe(box());
    expect(box().getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(box().getAttribute("aria-describedby")!)!.textContent).toBe("Press Enter to search");
    expect(box().maxLength).toBe(100);
  });

  it("typing does not search; Enter does, once, with the trimmed text", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput label="Search" onSearch={onSearch} />);
    type("  maya  ");
    act(() => vi.advanceTimersByTime(2000));
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.submit(box().closest("form")!);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("maya");
    expect(box().value).toBe("maya");
  });

  it("pressing Enter in the field submits the form", () => {
    const onSearch = vi.fn();
    render(<SearchInput label="Search" onSearch={onSearch} />);
    type("noor");
    // jsdom submits a form on Enter in its only text field via the implicit submission rule.
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.submit(box().closest("form")!);
    expect(onSearch).toHaveBeenCalledWith("noor");
  });

  it("shows an Enter hint while the typed text is not applied yet", () => {
    const { container } = render(<SearchInput label="Search" onSearch={() => undefined} />);
    expect(container.querySelector(".dash-search__hint")).toBeNull();
    type("a");
    expect(container.querySelector(".dash-search__hint")).not.toBeNull();
    fireEvent.submit(box().closest("form")!);
    expect(container.querySelector(".dash-search__hint")).toBeNull();
  });

  it("the clear button clears the box and searches for nothing", () => {
    const onSearch = vi.fn();
    render(<SearchInput label="Search" value="maya" onSearch={onSearch} />);
    expect(box().value).toBe("maya");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box().value).toBe("");
    expect(onSearch).toHaveBeenCalledWith("");
    expect(document.activeElement).toBe(box());
  });

  it("Escape clears and re-fires; on an empty box it does nothing", () => {
    const onSearch = vi.fn();
    render(<SearchInput label="Search" onSearch={onSearch} />);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onSearch).not.toHaveBeenCalled();
    type("abc");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box().value).toBe("");
    expect(onSearch).toHaveBeenCalledWith("");
  });

  it("follows `value` when the list's own search text changes (a link, the back button)", () => {
    function Host() {
      const [q, setQ] = useState("a");
      return (
        <>
          <SearchInput label="Search" value={q} onSearch={setQ} />
          <button onClick={() => setQ("from url")}>set</button>
        </>
      );
    }
    render(<Host />);
    expect(box().value).toBe("a");
    fireEvent.click(screen.getByRole("button", { name: "set" }));
    expect(box().value).toBe("from url");
  });

  it("`live` keeps the old behaviour: it searches 250 ms after typing stops, not on every key", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput label="Search" live onSearch={onSearch} />);
    type("m");
    type("ma");
    act(() => vi.advanceTimersByTime(200));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenLastCalledWith("ma");
  });
});

describe("SearchInput (old controlled props, until the screens are migrated)", () => {
  it("calls onChange on every keystroke and clears through it", () => {
    const onChange = vi.fn();
    render(<SearchInput label="Search" value="ab" onChange={onChange} maxLength={50} />);
    expect(box().maxLength).toBe(50);
    type("abc");
    expect(onChange).toHaveBeenLastCalledWith("abc");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("shows no Enter hint (the screen debounces itself)", () => {
    const { container } = render(<SearchInput label="Search" value="x" onChange={() => undefined} />);
    expect(container.querySelector(".dash-search__hint")).toBeNull();
    expect(box().getAttribute("aria-describedby")).toBeNull();
  });
});

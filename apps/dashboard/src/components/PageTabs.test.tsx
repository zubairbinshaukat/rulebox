import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PageTabPanel, PageTabs, type PageTab } from "./PageTabs";

const TABS: PageTab[] = [
  { id: "overview", label: "Overview" },
  { id: "apps", label: "Apps", count: 4 },
  { id: "problems", label: "Problems", count: 2, tone: "danger" },
  { id: "quiet", label: "Quiet", count: 0, tone: "warning" },
  { id: "activity", label: "Activity" },
];

function Harness({ start = "overview", onChange }: { start?: string; onChange?: (id: string) => void }) {
  const [v, setV] = useState(start);
  return (
    <PageTabs
      tabs={TABS}
      value={v}
      aria-label="Device sections"
      idBase="dev"
      onChange={(id) => {
        onChange?.(id);
        setV(id);
      }}
    >
      <PageTabPanel idBase="dev" id={v}>
        panel {v}
      </PageTabPanel>
    </PageTabs>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

describe("PageTabs", () => {
  it("is a labelled tablist with one tab per entry, only the open one selected and in the tab order", () => {
    render(<Harness start="apps" />);
    expect(screen.getByRole("tablist", { name: "Device sections" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    expect(tab("Apps").getAttribute("aria-selected")).toBe("true");
    expect(tab("Apps").tabIndex).toBe(0);
    for (const t of tabs.filter((x) => x !== tab("Apps"))) {
      expect(t.getAttribute("aria-selected")).toBe("false");
      expect(t.tabIndex).toBe(-1);
    }
  });

  it("links each tab to its panel and the panel back to its tab", () => {
    render(<Harness start="apps" />);
    expect(tab("Apps").getAttribute("aria-controls")).toBe("dev-panel-apps");
    expect(tab("Overview").getAttribute("aria-controls")).toBe("dev-panel-overview");
    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe("dev-panel-apps");
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Apps").id);
    expect(panel.tabIndex).toBe(0);
    expect(panel.textContent).toBe("panel apps");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("opens a tab on click", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(tab("Activity"));
    expect(onChange).toHaveBeenCalledWith("activity");
    expect(screen.getByRole("tabpanel").textContent).toBe("panel activity");
  });

  it("ArrowRight / ArrowLeft open and focus the next / previous tab, wrapping around", () => {
    render(<Harness />);
    tab("Overview").focus();
    fireEvent.keyDown(tab("Overview"), { key: "ArrowRight" });
    expect(tab("Apps").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Apps"));
    fireEvent.keyDown(tab("Apps"), { key: "ArrowLeft" });
    fireEvent.keyDown(tab("Overview"), { key: "ArrowLeft" });
    expect(tab("Activity").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Activity"));
    fireEvent.keyDown(tab("Activity"), { key: "ArrowRight" });
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
  });

  it("Home and End jump to the first and last tab", () => {
    render(<Harness start="apps" />);
    fireEvent.keyDown(tab("Apps"), { key: "End" });
    expect(tab("Activity").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Activity"));
    fireEvent.keyDown(tab("Activity"), { key: "Home" });
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Overview"));
  });

  it("leaves other keys and modified arrows alone", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(tab("Overview"), { key: "a" });
    fireEvent.keyDown(tab("Overview"), { key: "ArrowRight", altKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a count per tab; a zero count with a tone is hidden, a plain zero is not", () => {
    render(<Harness />);
    expect(tab("Apps").textContent).toBe("Apps4");
    const problems = tab("Problems").querySelector(".dash-ptabs__count");
    expect(problems?.textContent).toBe("2");
    expect(problems?.getAttribute("data-tone")).toBe("danger");
    expect(tab("Quiet").querySelector(".dash-ptabs__count")).toBeNull();
    expect(tab("Overview").querySelector(".dash-ptabs__count")).toBeNull();
  });

  it("keeps the open tab in view when it changes", () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      render(<Harness />);
      scroll.mockClear();
      fireEvent.click(tab("Activity"));
      expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ inline: "nearest", block: "nearest" }));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

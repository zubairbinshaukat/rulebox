import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { StatTile, StatTiles } from "./StatTile";

const wrap = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe("StatTile", () => {
  it("shows the label, the value and the extra words", () => {
    wrap(<StatTile label="PCs" value="523" sub="498 online" />);
    expect(screen.getByText("PCs")).toBeTruthy();
    expect(screen.getByText("523")).toBeTruthy();
    expect(screen.getByText("498 online")).toBeTruthy();
  });

  it("is a link when it has `to`, named by label, value and sub, with a chevron that is hidden from readers", () => {
    wrap(<StatTile label="Failed installs" value={4} sub="Open the list" to="/failed" tone="warning" />);
    const link = screen.getByRole("link", { name: "Failed installs 4 Open the list" });
    expect(link.getAttribute("href")).toBe("/failed");
    expect(link.getAttribute("data-tone")).toBe("warning");
    expect(link.querySelector(".dash-tile__go")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is one button when it has `onClick`", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    wrap(<StatTile label="Failed installs" value={4} onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Failed installs 4" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is plain text with no link or button otherwise, and can carry an (i) tip", async () => {
    const user = userEvent.setup();
    wrap(<StatTile label="Protection" value="Trial run" info="Blocking is only noted, not enforced." />);
    expect(screen.queryByRole("link")).toBeNull();
    const tip = screen.getByRole("button", { name: "About Protection" });
    await user.click(tip);
    expect(screen.getByText("Blocking is only noted, not enforced.")).toBeTruthy();
  });

  it("draws no tone, icon or tip unless asked", () => {
    const { container } = wrap(<StatTile label="Apps" value="37" />);
    const tile = container.querySelector(".dash-tile")!;
    expect(tile.hasAttribute("data-tone")).toBe(false);
    expect(container.querySelector(".dash-tile__icon")).toBeNull();
    expect(container.querySelector(".dash-tile__tip")).toBeNull();
  });

  it("puts a decorative icon in front", () => {
    const { container } = wrap(<StatTile label="Apps" value="37" icon={<svg data-testid="i" />} />);
    expect(container.querySelector(".dash-tile__icon")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("StatTiles", () => {
  it("is a list with one item per tile", () => {
    wrap(
      <StatTiles label="Numbers">
        <StatTile label="PCs" value="1" />
        <StatTile label="People" value="2" />
        <StatTile label="Apps" value="3" />
      </StatTiles>,
    );
    expect(screen.getByRole("list", { name: "Numbers" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DASHBOARD_API_VERSION } from "../../data";
import { settingsStrings } from "../../lib/screenStrings/settings";
import { AboutTab } from "./AboutTab";

afterEach(cleanup);
const s = settingsStrings.about;

function ui() {
  return render(
    <MemoryRouter>
      <AboutTab />
    </MemoryRouter>,
  );
}

describe("Settings → About", () => {
  it("shows the version and the credits up front, and the source code as a link that opens in a new tab", () => {
    ui();
    expect(screen.getByText(new RegExp(s.version))).toBeTruthy();
    expect(screen.getByText(s.solar)).toBeTruthy();
    expect(screen.getByText(s.fonts)).toBeTruthy();
    expect(screen.getByText(s.notices)).toBeTruthy();
    const link = screen.getByRole("link", { name: s.source });
    expect(link.getAttribute("href")).toBe(s.repoUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("the API version and the design gallery are under Technical details, closed", () => {
    ui();
    const tech = screen.getByText(s.technical).closest("details")!;
    expect(tech.hasAttribute("open")).toBe(false);
    expect(within(tech).getByText(String(DASHBOARD_API_VERSION))).toBeTruthy();
    // Tests run as a development build, where the gallery link exists; a normal installation has none.
    expect(within(tech).getByRole("link", { name: s.gallery }).getAttribute("href")).toBe("/gallery");
  });
});

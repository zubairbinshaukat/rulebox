import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import type { Me } from "../../data/types";
import { MeContext } from "../../lib/member";
import { settingsStrings } from "../../lib/screenStrings/settings";

// The shell of Settings (UI pass): the grouped section navigation, the URL, and "only the open section loads". The sections themselves
// are stubs here (their own tests cover them); each stub records that it was mounted.
const mounted = vi.hoisted(() => [] as string[]);
vi.mock("./OrganizationTab", async () => {
  const { useEffect } = await import("react");
  return {
    OrganizationTab: function Stub() {
      useEffect(() => void mounted.push("organization"), []);
      return <p>section:organization</p>;
    },
  };
});
vi.mock("./AdminExitTab", async () => {
  const { useEffect } = await import("react");
  return {
    AdminExitTab: function Stub() {
      useEffect(() => void mounted.push("adminExit"), []);
      return <p>section:adminExit</p>;
    },
  };
});
vi.mock("./MembersTab", async () => {
  const { useEffect } = await import("react");
  return {
    MembersTab: function Stub() {
      useEffect(() => void mounted.push("members"), []);
      return <p>section:members</p>;
    },
  };
});
vi.mock("./SigningTab", async () => {
  const { useEffect } = await import("react");
  return {
    SigningTab: function Stub() {
      useEffect(() => void mounted.push("signing"), []);
      return <p>section:signing</p>;
    },
  };
});
vi.mock("./SecurityTab", async () => {
  const { useEffect } = await import("react");
  return {
    default: function Stub() {
      useEffect(() => void mounted.push("security"), []);
      return <p>section:security</p>;
    },
  };
});
vi.mock("./UpdatesTab", async () => {
  const { useEffect } = await import("react");
  return {
    default: function Stub() {
      useEffect(() => void mounted.push("updates"), []);
      return <p>section:updates</p>;
    },
  };
});
vi.mock("./AboutTab", async () => {
  const { useEffect } = await import("react");
  return {
    AboutTab: function Stub() {
      useEffect(() => void mounted.push("about"), []);
      return <p>section:about</p>;
    },
  };
});

import Settings from "../Settings";

const s = settingsStrings;
const me: Me = {
  email: "owner@x.test",
  role: "owner",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
function Back() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      back
    </button>
  );
}
function ui(path = "/settings", over: Partial<Me> = {}, entries: string[] = [path]) {
  return render(
    <MeContext.Provider value={{ ...me, ...over }}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Settings />
        <Back />
        <Where />
      </MemoryRouter>
    </MeContext.Provider>,
  );
}
const where = () => screen.getByTestId("where").textContent;
const nav = () => screen.getByRole("navigation", { name: s.nav.label });

beforeEach(() => {
  mounted.length = 0;
});
afterEach(cleanup);

describe("Settings: the section navigation", () => {
  it("lists the sections in four groups, in the order people use them, as links", () => {
    ui();
    // Four groups, each a list named by its label.
    for (const label of Object.values(s.nav.groups)) expect(within(nav()).getByRole("list", { name: label })).toBeTruthy();
    const names = within(nav())
      .getAllByRole("link")
      .map((a) => a.textContent?.replace(s.nav.ownerOnly, "").trim());
    expect(names).toEqual(["General", "Members", "Your security", "Admin exit", "Rulebox updates", "Signing", "About"]);
    for (const label of Object.values(s.nav.groups)) expect(within(nav()).getByText(label)).toBeTruthy();
  });

  it("the open section is aria-current; the address keeps today's ids", () => {
    ui("/settings?tab=adminExit");
    const links = within(nav()).getAllByRole("link");
    expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual([s.nav.items.adminExit]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/settings",
      "/settings?tab=members",
      "/settings?tab=security",
      "/settings?tab=adminExit",
      "/settings?tab=updates",
      "/settings?tab=signing",
      "/settings?tab=about",
    ]);
  });

  it("General is the front door: no tab, or an unknown one, opens General and cleans the address", async () => {
    ui();
    expect(screen.getByText("section:organization")).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: s.nav.items.organization }).getAttribute("aria-current")).toBe("page");
    cleanup();
    ui("/settings?tab=banana");
    expect(screen.getByText("section:organization")).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/settings"));
  });

  it("the head shows the section's name and one short line", () => {
    ui("/settings?tab=security");
    expect(screen.getByRole("heading", { level: 2, name: s.nav.items.security })).toBeTruthy();
    expect(screen.getByText(s.leads.security)).toBeTruthy();
  });

  it("choosing a section changes ?tab= and drops every other parameter (Members' page and sort)", async () => {
    ui("/settings?tab=members&page=2&sort=role&dir=asc");
    expect(await screen.findByText("section:members")).toBeTruthy();
    fireEvent.click(within(nav()).getByRole("link", { name: s.nav.items.security }));
    expect(where()).toBe("/settings?tab=security");
    fireEvent.click(within(nav()).getByRole("link", { name: s.nav.items.organization }));
    expect(where()).toBe("/settings");
  });

  it("choosing a section replaces the history entry, so Back leaves Settings instead of walking through sections", () => {
    ui("/settings", {}, ["/overview", "/settings"]);
    fireEvent.click(within(nav()).getByRole("link", { name: s.nav.items.about }));
    fireEvent.click(within(nav()).getByRole("link", { name: s.nav.items.security }));
    expect(where()).toBe("/settings?tab=security");
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(where()).toBe("/overview");
  });
  it("Rulebox updates and Signing carry the lock for everyone, and only they", () => {
    for (const role of ["owner", "admin", "viewer"] as const) {
      cleanup();
      ui("/settings", { role });
      const locked = within(nav())
        .getAllByRole("link")
        .filter((a) => a.textContent?.includes(s.nav.ownerOnly))
        .map((a) => a.textContent?.replace(s.nav.ownerOnly, ""));
      expect(locked).toEqual([s.nav.items.updates, s.nav.items.signing]);
    }
  });

  it("Your security shows a dot while there is no action PIN yet, and not after", () => {
    ui("/settings", { pin: { required: true, set: false } });
    expect(within(nav()).getByRole("link", { name: new RegExp(s.nav.pinMissing) })).toBeTruthy();
    cleanup();
    ui("/settings");
    expect(within(nav()).queryByText(s.nav.pinMissing)).toBeNull();
  });
});

describe("Settings: only the open section loads", () => {
  it.each([
    ["/settings", "organization"],
    ["/settings?tab=organization", "organization"],
    ["/settings?tab=members", "members"],
    ["/settings?tab=security", "security"],
    ["/settings?tab=adminExit", "adminExit"],
    ["/settings?tab=updates", "updates"],
    ["/settings?tab=signing", "signing"],
    ["/settings?tab=about", "about"],
  ])("%s mounts the %s section and no other", async (path, id) => {
    ui(path);
    expect(await screen.findByText(`section:${id}`)).toBeTruthy();
    expect([...new Set(mounted)]).toEqual([id]);
  });

  it("the sections that need the PIN say so in their head; the others do not", () => {
    for (const [id, asks] of [
      ["adminExit", true],
      ["updates", true],
      ["signing", true],
      ["organization", false],
      ["security", false],
      ["about", false],
    ] as const) {
      cleanup();
      ui(id === "organization" ? "/settings" : `/settings?tab=${id}`);
      expect(screen.queryByText(s.asksPin) !== null).toBe(asks);
    }
  });
});

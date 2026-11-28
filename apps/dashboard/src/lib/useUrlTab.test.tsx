import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { useUrlTab } from "./useUrlTab";

const TABS = ["overview", "apps", "activity"] as const;

function setup(initial: string) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  return renderHook(
    () => {
      const [tab, setTab] = useUrlTab(TABS, "overview");
      const loc = useLocation();
      return { tab, setTab, search: loc.search };
    },
    { wrapper },
  );
}

describe("useUrlTab", () => {
  it("reads the tab from ?tab=", () => {
    expect(setup("/devices/1?tab=apps").result.current.tab).toBe("apps");
  });

  it("falls back when the parameter is missing or unknown", () => {
    expect(setup("/devices/1").result.current.tab).toBe("overview");
    expect(setup("/devices/1?tab=nope").result.current.tab).toBe("overview");
    expect(setup("/devices/1?tab=").result.current.tab).toBe("overview");
  });

  it("writes the tab, keeps other parameters, and drops the parameter for the fallback tab", () => {
    const { result } = setup("/devices/1?q=abc");
    act(() => result.current.setTab("activity"));
    expect(result.current.tab).toBe("activity");
    expect(new URLSearchParams(result.current.search).get("q")).toBe("abc");
    expect(new URLSearchParams(result.current.search).get("tab")).toBe("activity");
    act(() => result.current.setTab("overview"));
    expect(result.current.tab).toBe("overview");
    expect(result.current.search).toBe("?q=abc");
  });

  it("replaces the history entry instead of pushing one", () => {
    const { result } = renderHook(
      () => {
        const [tab, setTab] = useUrlTab(TABS, "overview");
        return { tab, setTab, nav: useLocation() };
      },
      { wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={["/a", "/b"]} initialIndex={1}>{children}</MemoryRouter> },
    );
    act(() => result.current.setTab("apps"));
    expect(result.current.nav.pathname).toBe("/b");
    expect(result.current.nav.search).toBe("?tab=apps");
  });

  it("supports another parameter name", () => {
    const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={["/x?view=apps"]}>{children}</MemoryRouter>;
    const { result } = renderHook(() => useUrlTab(TABS, "overview", "view"), { wrapper });
    expect(result.current[0]).toBe("apps");
  });
});

import { Suspense, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "@rulebox/ui";
import { RELOAD_KEY } from "../lib/chunkError";
import { ChunkErrorBoundary } from "./ChunkErrorBoundary";
import { lazyScreen } from "./screens";

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
}

/** A lazy screen whose chunk never downloads. */
function brokenScreen() {
  const load = vi.fn(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/Devices-abc.js")));
  // Only the "Devices" loader is used.
  const loaders = new Proxy({}, { get: () => load }) as Parameters<typeof lazyScreen>[1];
  return lazyScreen("Devices", loaders);
}

function renderWith(Screen: ComponentType, reload: () => void) {
  return render(
    <ChunkErrorBoundary reload={reload}>
      <Suspense fallback={<p>loading</p>}>
        <Screen />
      </Suspense>
    </ChunkErrorBoundary>,
  );
}

describe("ChunkErrorBoundary", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setOnline(true);
  });

  it("shows a retry panel instead of a blank page and reloads by itself once", async () => {
    setOnline(true);
    const reload = vi.fn();
    renderWith(brokenScreen(), reload);
    expect((await screen.findByRole("alert")).textContent).toContain("This part of the page didn't load.");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_KEY)).not.toBeNull();
  });

  it("does not reload again within the guard window; Try again reloads", async () => {
    setOnline(true);
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    const reload = vi.fn();
    renderWith(brokenScreen(), reload);
    await screen.findByRole("alert");
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offline, never reloads into the browser's error page: it waits for the connection", async () => {
    setOnline(false);
    const reload = vi.fn();
    renderWith(brokenScreen(), reload);
    await screen.findByRole("alert");
    expect(reload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert").textContent).toContain("Reconnecting…");
    expect(reload).not.toHaveBeenCalled();
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("clears the panel when the route changes", async () => {
    setOnline(false);
    const Screen = brokenScreen();
    const { rerender } = render(
      <ChunkErrorBoundary reload={vi.fn()} resetKey="/devices">
        <Suspense fallback={null}>
          <Screen />
        </Suspense>
      </ChunkErrorBoundary>,
    );
    await screen.findByRole("alert");
    rerender(
      <ChunkErrorBoundary reload={vi.fn()} resetKey="/groups">
        <h1>Groups</h1>
      </ChunkErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
  });

  it("passes any other error on to the boundary above", () => {
    const Broken = () => {
      throw new Error("boom");
    };
    render(
      <ErrorBoundary title="outer caught">
        <ChunkErrorBoundary reload={vi.fn()}>
          <Broken />
        </ChunkErrorBoundary>
      </ErrorBoundary>,
    );
    expect(screen.getByText("outer caught")).toBeTruthy();
  });
});

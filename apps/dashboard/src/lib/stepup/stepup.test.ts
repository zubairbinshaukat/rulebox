import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors";
import { setStepUpHandler, withStepUp } from "../stepUpRetry";
import type { StepUpStatus } from "../../data/types";
import { actionPinProblem, newPinError, pinInput } from "./pin";
import { StepUpController, type ChannelMessage, type OpenChannel } from "./controller";

describe("action PIN rules (mirror of convex/lib/stepUp.ts)", () => {
  it.each([
    ["12345", "6 to 12 digits"],
    ["1234567890123", "6 to 12 digits"],
    ["12a456", "6 to 12 digits"],
    ["１２３４５６", "6 to 12 digits"],
    ["111111", "repeated pattern"],
    ["121212", "repeated pattern"],
    ["123123", "repeated pattern"],
    ["123456", "sequence"],
    ["890123", "sequence"],
    ["987654", "sequence"],
    ["210987", "sequence"],
    ["147258", "too common"],
    ["482915", null],
    ["90817263", null],
  ])("%s → %s", (pin, problem) => {
    expect(actionPinProblem(pin)).toBe(problem);
  });

  it("maps problems to sentences and keeps only digits while typing", () => {
    expect(newPinError("123")).toMatch(/6 to 12 digits/);
    expect(newPinError("123456")).toMatch(/Avoid/);
    expect(newPinError("482915")).toBeNull();
    expect(pinInput("48 29-15abc999999")).toBe("482915999999");
  });
});

describe("withStepUp (the data seam's retry)", () => {
  it("passes errors through without a shell; retries once after a confirmation; never for 'sign in again'", async () => {
    const e = new AppError({ code: "step_up_required", detail: "fresh" });
    const call = vi.fn().mockRejectedValueOnce(e).mockResolvedValueOnce("ok");
    await expect(withStepUp(call)).rejects.toBe(e);
    const handler = vi.fn(async () => true);
    const off = setStepUpHandler(handler);
    const call2 = vi.fn().mockRejectedValueOnce(e).mockResolvedValueOnce("ok");
    await expect(withStepUp(call2)).resolves.toBe("ok");
    expect(call2).toHaveBeenCalledTimes(2);
    // A second refusal after the confirmation is not retried again.
    const call3 = vi.fn().mockRejectedValue(e);
    await expect(withStepUp(call3)).rejects.toBe(e);
    expect(call3).toHaveBeenCalledTimes(2);
    const reauth = new AppError({ code: "step_up_setup_required", detail: "reauthenticate" });
    await expect(withStepUp(vi.fn().mockRejectedValue(reauth))).rejects.toBe(reauth);
    expect(handler).toHaveBeenCalledTimes(2);
    off();
  });
});

function status(over: Partial<StepUpStatus["session"]> = {}, pin = true): StepUpStatus {
  return {
    actionPin: { set: pin, lockedUntil: null, disabled: false, attemptsBeforeDisable: 10 },
    passkeys: [],
    passkeysAvailable: true,
    session: { verifiedAt: 1000, lastActiveAt: 1000, method: "actionPin", ...over },
    bootstrapUntil: null,
    policy: { idleMs: 600_000, keepAliveMs: 300_000, freshMs: 300_000, maxAgeMs: 8 * 3600_000 },
  };
}

/** An in-memory BroadcastChannel shared by several controllers ("tabs"). */
function bus() {
  const peers = new Set<(m: ChannelMessage) => void>();
  const open: OpenChannel = (onMessage) => {
    peers.add(onMessage);
    return {
      post: (m) => {
        for (const p of peers) if (p !== onMessage) p(m);
      },
      close: () => peers.delete(onMessage),
    };
  };
  return open;
}

describe("StepUpController", () => {
  let wall = 0;
  let mono = 0;
  const target = () => new EventTarget() as unknown as Window;
  let win: Window;
  let doc: Document & { visibilityState: string };

  function make(extra: { openChannel?: OpenChannel; idleOverrideMs?: number } = {}) {
    const c = new StepUpController({
      wallNow: () => wall,
      monoNow: () => mono,
      isRealInput: () => true,
      win,
      doc,
      openChannel: extra.openChannel ?? (() => null),
      idleOverrideMs: extra.idleOverrideMs,
    });
    const deps = {
      keepAlive: vi.fn(async () => ({ serverNow: wall + 5000 })),
      lock: vi.fn(async () => undefined),
    };
    c.setDeps(deps);
    return { c, deps };
  }

  const advance = (ms: number, clocks: "both" | "wall" | "mono" = "both") => {
    if (clocks !== "mono") wall += ms;
    if (clocks !== "wall") mono += ms;
    vi.advanceTimersByTime(ms);
  };
  const input = (type = "keydown") => win.dispatchEvent(new Event(type));

  beforeEach(() => {
    vi.useFakeTimers();
    wall = 1_000_000;
    mono = 50;
    win = target();
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" }) as unknown as Document & { visibilityState: string };
  });
  afterEach(() => vi.useRealTimers());

  it("locks after the idle limit without input, and calls stepUp:lock once", () => {
    const { c, deps } = make();
    c.start();
    c.onStatus(status());
    advance(599_000);
    expect(c.getSnapshot().locked).toBe(false);
    advance(2_000);
    expect(c.getSnapshot()).toMatchObject({ locked: true, reason: "idle" });
    expect(deps.lock).toHaveBeenCalledOnce();
  });

  it("real input postpones the lock; no timer fires every second", () => {
    const { c } = make();
    c.start();
    c.onStatus(status());
    const spy = vi.spyOn(globalThis, "setTimeout");
    for (let i = 0; i < 10; i++) {
      advance(300_000);
      input("pointermove");
    }
    expect(c.getSnapshot().locked).toBe(false);
    // One re-arm per idle period at most, never per second.
    expect(spy.mock.calls.length).toBeLessThan(15);
  });

  it("does not lock a person without any factor (nothing to unlock with)", () => {
    const { c } = make();
    c.start();
    c.onStatus(status({ verifiedAt: null, lastActiveAt: null, method: null }, false));
    advance(700_000);
    expect(c.getSnapshot().locked).toBe(false);
  });

  it("after sleep: the timer is late, but becoming visible checks the elapsed time at once", () => {
    const { c } = make();
    c.start();
    c.onStatus(status());
    // The laptop sleeps: the wall clock jumps, the monotonic clock stood still, no timer ran.
    wall += 20 * 60_000;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(c.getSnapshot().locked).toBe(true);
  });

  it("a clock set backwards does not keep the session open (monotonic clock)", () => {
    const { c } = make();
    c.start();
    c.onStatus(status());
    wall -= 3_600_000;
    advance(601_000);
    expect(c.getSnapshot().locked).toBe(true);
  });

  it("keep-alive: at most every keepAliveMs, only with input and only while verified", async () => {
    const { c, deps } = make();
    c.start();
    c.onStatus(status());
    input();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.keepAlive).toHaveBeenCalledTimes(1);
    advance(60_000);
    input();
    expect(deps.keepAlive).toHaveBeenCalledTimes(1);
    advance(250_000);
    input();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.keepAlive).toHaveBeenCalledTimes(2);
    // Not verified (fresh sign-in): no keep-alive (it would only fail).
    c.onStatus(status({ verifiedAt: null, lastActiveAt: null, method: null }));
    advance(300_000);
    input();
    expect(deps.keepAlive).toHaveBeenCalledTimes(2);
  });

  it("offline keep-alive: no answer is no reason to lock, and nothing piles up", async () => {
    const { c, deps } = make();
    deps.keepAlive.mockImplementation(() => new Promise(() => undefined)); // queued by the client, never answered
    c.start();
    c.onStatus(status());
    input();
    advance(300_000);
    input();
    expect(deps.keepAlive).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().locked).toBe(false);
  });

  it("a network failure retries later; a server 'not unlocked' locks (never fails open)", async () => {
    const { c, deps } = make();
    deps.keepAlive.mockRejectedValueOnce(new Error("network"));
    c.start();
    c.onStatus(status());
    input();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().locked).toBe(false);
    advance(31_000);
    deps.keepAlive.mockRejectedValueOnce(new AppError({ code: "step_up_required", detail: "unlocked" }));
    input();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.keepAlive).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ locked: true, reason: "server" });
  });

  it("two tabs: input in one keeps the other open; a lock in one locks both; one unlock unlocks both", () => {
    const open = bus();
    const a = make({ openChannel: open });
    const b = make({ openChannel: open });
    a.c.start();
    b.c.start();
    a.c.onStatus(status());
    b.c.onStatus(status());
    // The person works in tab A; tab B is in the background.
    for (let i = 0; i < 4; i++) {
      advance(200_000);
      input();
    }
    expect(b.c.getSnapshot().locked).toBe(false);
    a.c.lockNow("manual");
    expect(b.c.getSnapshot()).toMatchObject({ locked: true, reason: "elsewhere" });
    expect(b.deps.lock).not.toHaveBeenCalled();
    // The server deletes the row, then tab A unlocks: both see a new verification.
    a.c.onStatus(status({ verifiedAt: null, lastActiveAt: null, method: null }));
    b.c.onStatus(status({ verifiedAt: null, lastActiveAt: null, method: null }));
    a.c.unlocked(wall);
    b.c.onStatus(status({ verifiedAt: 999_999_999 }));
    expect(b.c.getSnapshot().locked).toBe(false);
  });

  it("stays locked while the lock call is still queued (the old verification is not an unlock)", () => {
    const { c } = make();
    c.start();
    c.onStatus(status({ verifiedAt: 5000 }));
    c.lockNow("idle");
    c.onStatus(status({ verifiedAt: 5000 }));
    expect(c.getSnapshot().locked).toBe(true);
    c.onStatus(status({ verifiedAt: 6000 }));
    expect(c.getSnapshot().locked).toBe(false);
  });

  it("requests share one dialog; settle resolves them; a lock cancels them", async () => {
    const { c } = make();
    c.start();
    c.onStatus(status());
    const e = new AppError({ code: "step_up_required", detail: "fresh" });
    const p1 = c.request(e);
    const p2 = c.request(e);
    expect(c.getSnapshot().request?.error).toBe(e);
    c.settle(true, wall);
    await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
    expect(c.getSnapshot().request).toBeNull();
    const p3 = c.request(e);
    c.lockNow("idle");
    await expect(p3).resolves.toBe(false);
    expect(c.getSnapshot().request).toBeNull();
    // While locked no dialog opens.
    await expect(c.request(e)).resolves.toBe(false);
  });

  it("the dev-server idle override replaces the server's policy", () => {
    const { c } = make({ idleOverrideMs: 20_000 });
    c.start();
    c.onStatus(status());
    advance(21_000);
    expect(c.getSnapshot().locked).toBe(true);
  });

  it("toLocal / serverNow follow the server's clock offset", () => {
    const { c } = make();
    c.noteServerNow(wall + 120_000);
    expect(c.serverNow()).toBe(wall + 120_000);
    expect(c.toLocal(wall + 120_000)).toBe(wall);
  });
});

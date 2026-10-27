/**
 * The dashboard side of step-up (plan 4.16), without React: the idle lock,
 * the keep-alive cadence, the tabs of one browser, and the queue of calls
 * waiting for a confirmation. `stepup/StepUpProvider.tsx` connects it to the
 * data hooks and renders what `getSnapshot()` says.
 *
 * Idle time is measured here from real input only (pointer, keyboard, touch;
 * passive listeners), with no timer ticking every second: one timeout per
 * idle period, re-armed when it fires early, plus a check whenever the page
 * becomes visible or regains focus. Elapsed time is the larger of the wall
 * clock and the monotonic clock, so a laptop that slept (the monotonic clock
 * may stop) and a clock set backwards (the wall clock jumps) both still lock;
 * a clock set forwards locks early, which is the safe side.
 *
 * Tabs share one session: each tab tells the others about input (at most every
 * `BROADCAST_EVERY_MS`) and about a lock, through a BroadcastChannel (no
 * storage, nothing secret). An unlock in one tab reaches the others through the
 * live `stepUp:status` query: a verification the locked tab has not seen before.
 */
import type { StepUpStatus } from "../../data/types";
import { errorCodeOf } from "../errors";

export type ChannelMessage = { t: "active" } | { t: "lock" };

export interface Channel {
  post: (message: ChannelMessage) => void;
  close: () => void;
}

export type OpenChannel = (onMessage: (message: ChannelMessage) => void) => Channel | null;

/** The real cross-tab channel (null where BroadcastChannel does not exist). */
export const openBroadcastChannel: OpenChannel = (onMessage) => {
  if (typeof BroadcastChannel !== "function") return null;
  const bc = new BroadcastChannel("rulebox.stepup");
  bc.onmessage = (e: MessageEvent<unknown>) => {
    const d = e.data as { t?: unknown } | null;
    if (d && (d.t === "active" || d.t === "lock")) onMessage({ t: d.t });
  };
  return { post: (m) => bc.postMessage(m), close: () => bc.close() };
};

export type LockReason = "idle" | "manual" | "elsewhere" | "server";

/** Why a call needs a confirmation: the error it failed with. */
export interface StepUpRequest {
  id: number;
  error: unknown;
}

export interface Snapshot {
  locked: boolean;
  reason: LockReason | null;
  /** The call waiting for the confirm dialog (null when none). */
  request: StepUpRequest | null;
  /** The first-factor setup screen is in progress (stays until "Continue"). */
  setupActive: boolean;
}

export interface ControllerDeps {
  keepAlive: () => Promise<{ serverNow: number }>;
  lock: () => Promise<void>;
}

export interface ControllerOptions {
  openChannel?: OpenChannel;
  /** Only real input counts (default: `event.isTrusted`). */
  isRealInput?: (e: Event) => boolean;
  wallNow?: () => number;
  monoNow?: () => number;
  /** Idle limit instead of the server's policy (the dev-server test hook). */
  idleOverrideMs?: number;
  win?: Window;
  doc?: Document;
}

/** Real input. `pointermove` and `wheel` count too: reading with the mouse is not being away. */
export const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"] as const;
/** Moments the page may have been asleep or hidden: check the elapsed time at once. */
const WAKE_EVENTS = ["focus", "pageshow", "online"] as const;

export const DEFAULT_IDLE_MS = 10 * 60_000;
export const DEFAULT_KEEPALIVE_MS = 5 * 60_000;
export const BROADCAST_EVERY_MS = 15_000;
/** After a keep-alive failed without an answer (network), try again on input after this long. */
export const KEEPALIVE_RETRY_MS = 30_000;

export class StepUpController {
  private snap: Snapshot = { locked: false, reason: null, request: null, setupActive: false };
  private listeners = new Set<() => void>();
  private deps: ControllerDeps | null = null;

  private idleMs = DEFAULT_IDLE_MS;
  private keepAliveMs = DEFAULT_KEEPALIVE_MS;
  private readonly idleOverrideMs: number;

  private lastWall: number;
  private lastMono: number;
  private lastBroadcast = 0;
  private lastKeepAlive = 0;
  private keepAliveInFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private channel: Channel | null = null;

  /** Server − local clock, from the latest `serverNow` answer. */
  private offset = 0;
  private hasFactor = false;
  private verifiedAt: number | null = null;
  /** While locked: the verification the lock replaced, and whether the server showed none since. */
  private lockedVerifiedAt: number | null = null;
  private sawNoVerification = false;

  private nextRequestId = 1;
  private waiting: { id: number; resolve: (ok: boolean) => void }[] = [];

  private readonly wallNow: () => number;
  private readonly monoNow: () => number;
  private readonly isRealInput: (e: Event) => boolean;
  private readonly openChannel: OpenChannel;
  private readonly win: Window | undefined;
  private readonly doc: Document | undefined;

  constructor(options: ControllerOptions = {}) {
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.monoNow = options.monoNow ?? (() => performance.now());
    this.isRealInput = options.isRealInput ?? ((e) => e.isTrusted);
    this.openChannel = options.openChannel ?? openBroadcastChannel;
    this.idleOverrideMs = options.idleOverrideMs ?? 0;
    this.win = options.win ?? (typeof window === "undefined" ? undefined : window);
    this.doc = options.doc ?? (typeof document === "undefined" ? undefined : document);
    this.lastWall = this.wallNow();
    this.lastMono = this.monoNow();
    if (this.idleOverrideMs > 0) this.idleMs = this.idleOverrideMs;
  }

  // ------------------------------------------------------------ store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Snapshot => this.snap;

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  setDeps(deps: ControllerDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    if (this.started) return;
    this.started = true;
    const w = this.win;
    const d = this.doc;
    for (const name of INPUT_EVENTS) w?.addEventListener(name, this.onInput, { passive: true, capture: true });
    for (const name of WAKE_EVENTS) w?.addEventListener(name, this.check);
    d?.addEventListener("visibilitychange", this.onVisibility);
    this.channel = this.openChannel(this.onMessage);
    this.markActive();
    this.arm();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    const w = this.win;
    const d = this.doc;
    for (const name of INPUT_EVENTS) w?.removeEventListener(name, this.onInput, { capture: true });
    for (const name of WAKE_EVENTS) w?.removeEventListener(name, this.check);
    d?.removeEventListener("visibilitychange", this.onVisibility);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.channel?.close();
    this.channel = null;
    // Nothing may wait on a dialog that is gone.
    this.settleAll(false);
  }

  // ------------------------------------------------------------ server state

  /** Every `stepUp:status` answer (null while loading or failed). */
  onStatus(status: StepUpStatus | null) {
    if (!status) return;
    if (this.idleOverrideMs <= 0) this.idleMs = status.policy.idleMs;
    this.keepAliveMs = status.policy.keepAliveMs;
    this.hasFactor = status.actionPin.set || status.passkeys.length > 0;
    this.verifiedAt = status.session.verifiedAt;
    if (!this.snap.locked) {
      this.arm();
      return;
    }
    // Locked here: unlock when the session shows a verification made after the
    // lock (in this tab or another one). Server rows, no clocks compared.
    if (this.verifiedAt === null) this.sawNoVerification = true;
    else if (this.sawNoVerification || this.verifiedAt !== this.lockedVerifiedAt) this.unlocked();
  }

  noteServerNow(serverNow: number) {
    this.offset = serverNow - this.wallNow();
  }

  /** Server time now, as well as this browser knows it. */
  serverNow(): number {
    return this.wallNow() + this.offset;
  }

  /** Local time of a server timestamp. */
  toLocal(serverMs: number): number {
    return serverMs - this.offset;
  }

  // ------------------------------------------------------------ activity

  private onInput = (e: Event) => {
    if (!this.isRealInput(e) || this.snap.locked) return;
    this.markActive();
    const now = this.wallNow();
    if (now - this.lastBroadcast >= BROADCAST_EVERY_MS) {
      this.lastBroadcast = now;
      this.channel?.post({ t: "active" });
    }
    this.maybeKeepAlive(now);
  };

  private onMessage = (m: ChannelMessage) => {
    if (m.t === "active") {
      if (!this.snap.locked) this.markActive();
    } else this.lockNow("elsewhere", false);
  };

  private onVisibility = () => {
    if (this.doc?.visibilityState !== "hidden") this.check();
  };

  private markActive() {
    this.lastWall = this.wallNow();
    this.lastMono = this.monoNow();
  }

  /** Time since the last input: the larger of the two clocks (see the file comment). */
  idleFor(): number {
    const wall = this.wallNow() - this.lastWall;
    const mono = this.monoNow() - this.lastMono;
    return Math.max(wall, mono, 0);
  }

  private arm() {
    if (!this.started || this.snap.locked) return;
    clearTimeout(this.timer);
    const left = this.idleMs - this.idleFor();
    // Never a busy loop: at least one second between checks.
    this.timer = setTimeout(this.check, Math.max(1000, left));
  }

  /** Lock if idle long enough, else wait for the rest (also on wake, focus, visibility). */
  check = () => {
    if (!this.started || this.snap.locked) return;
    if (this.idleFor() >= this.idleMs && this.hasFactor) {
      this.lockNow("idle");
      return;
    }
    this.arm();
  };

  private maybeKeepAlive(now: number) {
    const deps = this.deps;
    if (!deps || this.keepAliveInFlight || this.verifiedAt === null) return;
    if (now - this.lastKeepAlive < this.keepAliveMs) return;
    this.keepAliveInFlight = true;
    this.lastKeepAlive = now;
    deps.keepAlive().then(
      (r) => {
        this.keepAliveInFlight = false;
        this.noteServerNow(r.serverNow);
      },
      (e: unknown) => {
        this.keepAliveInFlight = false;
        const code = errorCodeOf(e);
        // The server no longer counts this session as unlocked: lock (never fail open).
        if (code === "step_up_required" || code === "step_up_setup_required") this.lockNow("server");
        // No answer (network): not a reason to lock; try again on input a bit later.
        else if (code === null) this.lastKeepAlive = this.wallNow() - this.keepAliveMs + KEEPALIVE_RETRY_MS;
      },
    );
  }

  // ------------------------------------------------------------ lock / unlock

  /**
   * Lock this tab (and, unless the lock came from another tab, the others):
   * the screens are hidden, waiting calls are cancelled, and `stepUp:lock`
   * removes the session's unlock on the server.
   */
  lockNow(reason: LockReason, tellServer = true) {
    if (this.snap.locked) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.lockedVerifiedAt = this.verifiedAt;
    this.sawNoVerification = this.verifiedAt === null;
    this.settleAll(false);
    this.set({ locked: true, reason, request: null });
    if (tellServer) {
      this.channel?.post({ t: "lock" });
      // A failed lock call is fine: this tab stays locked until a verification.
      this.deps?.lock().catch(() => undefined);
    }
  }

  /** A verification succeeded (here, or seen in the status): show the screens again. */
  unlocked(serverNow?: number) {
    if (serverNow !== undefined) this.noteServerNow(serverNow);
    this.markActive();
    // The verification itself was activity on the server: no keep-alive for a while.
    this.lastKeepAlive = this.wallNow();
    if (this.snap.locked) this.set({ locked: false, reason: null });
    this.arm();
  }

  // ------------------------------------------------------------ confirm requests

  /**
   * A call failed with `step_up_required` / `step_up_setup_required`: show the
   * confirm dialog. Resolves true after a verification, false when cancelled
   * or locked. Calls arriving while the dialog is open share its outcome.
   */
  request(error: unknown): Promise<boolean> {
    if (this.snap.locked || !this.started) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = this.snap.request?.id ?? this.nextRequestId++;
      this.waiting.push({ id, resolve });
      if (!this.snap.request) this.set({ request: { id, error } });
    });
  }

  /** The dialog closed: `ok` after a verification. */
  settle(ok: boolean, serverNow?: number) {
    if (ok) this.unlocked(serverNow);
    this.settleAll(ok);
    if (this.snap.request) this.set({ request: null });
  }

  private settleAll(ok: boolean) {
    const waiting = this.waiting;
    this.waiting = [];
    for (const w of waiting) w.resolve(ok);
  }

  // ------------------------------------------------------------ first-factor setup

  beginSetup() {
    if (!this.snap.setupActive) this.set({ setupActive: true });
  }

  finishSetup() {
    if (this.snap.setupActive) this.set({ setupActive: false });
  }
}

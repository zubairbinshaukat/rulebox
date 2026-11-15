import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { BroadcastRow, DeviceDetail, Me } from "../data/types";
import { ackRatio, broadcastStatus, expiryFor, noticeProblem } from "../lib/noticeRules";
import { MeContext } from "../lib/member";
import { broadcastStrings as s, lockStrings as ls } from "./broadcasts/strings";

// Phase 5 Step 15 screens (the Broadcasts screen, the send dialog, the lock card of the device page) against the LIVE data seam
// with the Convex React hooks mocked, like step14b.test.tsx.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  queried: [] as { name: string; args: unknown }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push({ name: getFunctionName(r.query), args: r.args });
        return [k, cx.results[getFunctionName(r.query)]];
      }),
    ),
  useQuery: () => undefined,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

type Mock = ((args?: unknown) => Promise<unknown>) & { withOptimisticUpdate: () => Mock };
const stable = new Map<string, Mock>();
function fnFor(name: string): Mock {
  let f = stable.get(name);
  if (!f) {
    const call = ((args?: unknown) => {
      const impl = cx.fns[name];
      if (!impl) throw new Error(`no mock for ${name}`);
      return impl(args);
    }) as Mock;
    call.withOptimisticUpdate = () => call;
    f = call;
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../app/Toasts";
import Broadcasts from "./Broadcasts";
import { LockCard } from "./broadcasts/LockCard";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme Pharmacy",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function ui(node: ReactNode, role: Me["role"], path = "/broadcasts") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const NOW = Date.now();
const HOUR = 3_600_000;
const row = (over: Partial<BroadcastRow> = {}): BroadcastRow => ({
  _id: "b1",
  target: { kind: "group", id: "g1", name: "Front desk" },
  style: "banner",
  title: "Till update tonight",
  body: "The tills restart at 18:30.",
  expiresAt: NOW + 6 * HOUR,
  ackRequired: false,
  createdAt: NOW - HOUR,
  cancelledAt: null,
  targetCount: 4,
  ackCount: 0,
  ...over,
});
const page = (rows: BroadcastRow[]) => ({ page: rows, isDone: true, continueCursor: "" });
const groupRow = (id: string, name: string) => ({ _id: id, name, revision: 0, createdAt: 1, devices: { count: 0, more: false }, employees: { count: 0, more: false } });

beforeEach(() => {
  cx.results = { "broadcasts:list": page([]), "groups:list": [groupRow("g1", "Front desk"), groupRow("g2", "Back office")] };
  cx.queried = [];
  cx.fns = {};
});
afterEach(cleanup);

describe("the rules of the forms", () => {
  it("judge a text trimmed: empty, too long, control characters; line breaks only where allowed", () => {
    expect(noticeProblem("   ", 80, { multiline: false })).toBe("empty");
    expect(noticeProblem("", 80, { multiline: false, optional: true })).toBeNull();
    expect(noticeProblem("x".repeat(81), 80, { multiline: false })).toBe("tooLong");
    expect(noticeProblem("x".repeat(80), 80, { multiline: false })).toBeNull();
    expect(noticeProblem("a\u0007b", 80, { multiline: false })).toBe("control");
    expect(noticeProblem("two\nlines", 80, { multiline: false })).toBe("control");
    expect(noticeProblem("two\nlines", 80, { multiline: true })).toBeNull();
    expect(noticeProblem("<b>hi</b> &amp; <script>", 80, { multiline: false })).toBeNull();
  });

  it("work out a status (cancelled wins over expired), the expiry choices and the acknowledgement ratio", () => {
    expect(broadcastStatus({ cancelledAt: null, expiresAt: null }, NOW)).toBe("active");
    expect(broadcastStatus({ cancelledAt: null, expiresAt: NOW }, NOW)).toBe("expired");
    expect(broadcastStatus({ cancelledAt: NOW - 1, expiresAt: NOW - 5 }, NOW)).toBe("cancelled");
    expect(expiryFor("none", NOW)).toBeUndefined();
    expect(expiryFor("24h", NOW)).toBe(NOW + 24 * HOUR);
    expect(ackRatio({ ackCount: 3, targetCount: 5 })).toEqual({ acked: 3, of: 5 });
    expect(ackRatio({ ackCount: 6, targetCount: 5 })).toEqual({ acked: 6, of: 6 });
  });
});

describe("the Broadcasts screen", () => {
  it("lists the messages newest first as the server gave them, with target, status and 'n of m PCs' only when an acknowledgement was asked for", () => {
    cx.results["broadcasts:list"] = page([
      row({ _id: "b1", title: "Privacy rules", ackRequired: true, ackCount: 3, targetCount: 5, style: "fullscreen", expiresAt: null }),
      row({ _id: "b2", title: "Fire drill", expiresAt: NOW - HOUR, target: { kind: "device", id: "d1", name: "Desk 1" } }),
      row({ _id: "b3", title: "Cancelled one", cancelledAt: NOW - 1_000, target: { kind: "group", id: "gone", name: null } }),
    ]);
    ui(<Broadcasts />, "admin");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Privacy rules")).toBeTruthy();
    expect(within(rows[0]!).getByText(s.acks(3, 5))).toBeTruthy();
    expect(within(rows[0]!).getByText(s.statuses.active)).toBeTruthy();
    expect(within(rows[1]!).getByText(s.statuses.expired)).toBeTruthy();
    expect(within(rows[1]!).getByText("Desk 1")).toBeTruthy();
    expect(within(rows[1]!).getByText(s.noAckNeeded)).toBeTruthy();
    expect(within(rows[2]!).getByText(s.statuses.cancelled)).toBeTruthy();
    expect(within(rows[2]!).getByText(s.gone)).toBeTruthy();
    // Only the active one can be cancelled.
    expect(screen.getAllByRole("button", { name: s.cancel })).toHaveLength(1);
    // The query asks for ONE page, newest first, with no search.
    const asked = cx.queried.find((q) => q.name === "broadcasts:list")!.args as { paginationOpts: { numItems: number }; sort: unknown };
    expect(asked.sort).toEqual({ key: "sent", dir: "desc" });
    expect(asked.paginationOpts.numItems).toBeGreaterThan(0);
  });

  it("shows message text as text: markup typed into a title or body is not interpreted", () => {
    cx.results["broadcasts:list"] = page([row({ title: "<b>Bold?</b>", body: "<img src=x onerror=alert(1)> & more" })]);
    const { container } = ui(<Broadcasts />, "viewer");
    expect(screen.getByText("<b>Bold?</b>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("an empty list gets the empty state; a viewer sees neither Send nor Cancel", () => {
    ui(<Broadcasts />, "admin");
    expect(screen.getByText(s.emptyTitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: s.send })).toBeTruthy();
    cleanup();
    cx.results["broadcasts:list"] = page([row()]);
    ui(<Broadcasts />, "viewer");
    expect(screen.queryByRole("button", { name: s.send })).toBeNull();
    expect(screen.queryByRole("button", { name: s.cancel })).toBeNull();
    expect(screen.getByText("Till update tonight")).toBeTruthy();
  });

  it("cancels an active message after a confirmation", async () => {
    const cancel = vi.fn(async () => null);
    cx.fns["broadcasts:cancel"] = cancel;
    cx.results["broadcasts:list"] = page([row()]);
    ui(<Broadcasts />, "admin");
    fireEvent.click(screen.getByRole("button", { name: s.cancel }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(s.cancelTitle("Till update tonight"))).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: s.cancel }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ id: "b1" }));
    expect(await screen.findByText(s.cancelled)).toBeTruthy();
  });
});

describe("the send dialog", () => {
  const open = () => {
    ui(<Broadcasts />, "admin");
    fireEvent.click(screen.getByRole("button", { name: s.send }));
    return screen.getByRole("dialog");
  };
  const byLabel = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText(new RegExp(`^${label}`));

  it("asks for a group, a title and a message in words before it calls the server", () => {
    const send = vi.fn();
    cx.fns["broadcasts:send"] = send;
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: s.submit }));
    expect(within(dialog).getByText(s.targetProblem)).toBeTruthy();
    expect(within(dialog).getByText(s.titleProblems.empty)).toBeTruthy();
    expect(within(dialog).getByText(s.bodyProblems.empty)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends to the chosen group with the chosen style, expiry and acknowledgement, and shows a preview of the text as typed", async () => {
    const send = vi.fn<(args: unknown) => Promise<{ id: string; targetCount: number }>>(async () => ({ id: "b9", targetCount: 4 }));
    cx.fns["broadcasts:send"] = send;
    const dialog = open();
    fireEvent.change(byLabel(dialog, s.toGroup), { target: { value: "g2" } });
    fireEvent.change(byLabel(dialog, s.style), { target: { value: "fullscreen" } });
    fireEvent.change(byLabel(dialog, s.messageTitle), { target: { value: "  <i>Read me</i>  " } });
    fireEvent.change(byLabel(dialog, s.body), { target: { value: "Line one\nLine two" } });
    fireEvent.change(byLabel(dialog, s.expiry), { target: { value: "4h" } });
    fireEvent.click(within(dialog).getByLabelText(new RegExp(s.ackRequired)));
    // The preview is text, not markup.
    expect(within(dialog).getAllByText("<i>Read me</i>").length).toBeGreaterThan(0);
    expect(dialog.querySelector("i")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: s.submit }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const args = send.mock.calls[0]![0] as { target: unknown; style: string; title: string; body: string; expiresAt: number; ackRequired: boolean };
    expect(args).toMatchObject({ target: { kind: "group", id: "g2" }, style: "fullscreen", title: "<i>Read me</i>", body: "Line one\nLine two", ackRequired: true });
    expect(args.expiresAt).toBeGreaterThan(Date.now() + 3 * HOUR);
    expect(args.expiresAt).toBeLessThanOrEqual(Date.now() + 4 * HOUR);
    expect(await screen.findByText(s.sent(4))).toBeTruthy();
  });

  it("sends without an expiry when 'until I cancel it' is chosen", async () => {
    const send = vi.fn<(args: unknown) => Promise<{ id: string; targetCount: number }>>(async () => ({ id: "b9", targetCount: 1 }));
    cx.fns["broadcasts:send"] = send;
    const dialog = open();
    fireEvent.change(byLabel(dialog, s.toGroup), { target: { value: "g1" } });
    fireEvent.change(byLabel(dialog, s.messageTitle), { target: { value: "Hello" } });
    fireEvent.change(byLabel(dialog, s.body), { target: { value: "World" } });
    fireEvent.change(byLabel(dialog, s.expiry), { target: { value: "none" } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.submit }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0]![0] as { expiresAt?: number }).expiresAt).toBeUndefined();
  });

  it("says in words that 20 active messages is the limit, and keeps the dialog open", async () => {
    cx.fns["broadcasts:send"] = vi.fn().mockRejectedValue(new ConvexError({ code: "too_large", detail: "active" }));
    const dialog = open();
    fireEvent.change(byLabel(dialog, s.toGroup), { target: { value: "g1" } });
    fireEvent.change(byLabel(dialog, s.messageTitle), { target: { value: "Hello" } });
    fireEvent.change(byLabel(dialog, s.body), { target: { value: "World" } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.submit }));
    expect(await within(dialog).findByText(s.tooManyActive)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

const device = (over: Partial<DeviceDetail> = {}): DeviceDetail => ({
  _id: "d1",
  name: "Desk 1",
  revision: 1,
  revoked: false,
  kioskEnabled: true,
  enrolledAt: 1,
  group: { _id: "g1", name: "Front desk" },
  presence: { online: true, since: 1 },
  report: null,
  versions: [],
  flags: { noGroup: false, revoked: false, rotateCredential: false },
  lock: null,
  groups: [],
  ...over,
});

describe("the lock card of the device page", () => {
  it("locks with a message and a contact, shows a preview, and refuses an empty message in words", async () => {
    const lock = vi.fn(async () => ({ lockId: "l1" }));
    cx.fns["fleet:lock"] = lock;
    ui(<LockCard d={device()} />, "admin");
    const card = screen.getByRole("heading", { name: ls.title }).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: ls.lock }));
    expect(within(card).getByText(ls.messageProblems.empty)).toBeTruthy();
    expect(lock).not.toHaveBeenCalled();

    fireEvent.change(within(card).getByLabelText(new RegExp(`^${ls.message}`)), { target: { value: "  Call the front desk.  " } });
    fireEvent.change(within(card).getByLabelText(new RegExp(`^${ls.contact}`)), { target: { value: " ext. 12 " } });
    // The preview names the organization and shows the contact.
    expect(within(card).getByText("Acme Pharmacy")).toBeTruthy();
    expect(within(card).getByText(ls.previewContact("ext. 12"))).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: ls.lock }));
    await waitFor(() => expect(lock).toHaveBeenCalledWith({ deviceId: "d1", message: "Call the front desk.", contact: "ext. 12" }));
    expect(await screen.findByText(ls.locked_ok)).toBeTruthy();
  });

  it("leaves the contact out when it is blank", async () => {
    const lock = vi.fn(async () => ({ lockId: "l1" }));
    cx.fns["fleet:lock"] = lock;
    ui(<LockCard d={device()} />, "admin");
    const card = screen.getByRole("heading", { name: ls.title }).closest("section")!;
    fireEvent.change(within(card).getByLabelText(new RegExp(`^${ls.message}`)), { target: { value: "Locked" } });
    fireEvent.click(within(card).getByRole("button", { name: ls.lock }));
    await waitFor(() => expect(lock).toHaveBeenCalledWith({ deviceId: "d1", message: "Locked" }));
  });

  it("a locked PC shows the state, keeps the text editable, and unlocks after a confirmation", async () => {
    const unlock = vi.fn(async () => null);
    cx.fns["fleet:unlock"] = unlock;
    ui(<LockCard d={device({ lock: { lockId: "l1", message: "Call IT", contact: "ext. 1", lockedAt: NOW } })} />, "admin");
    const card = screen.getByRole("heading", { name: ls.title }).closest("section")!;
    expect(within(card).getByText(ls.locked)).toBeTruthy();
    expect((within(card).getByLabelText(new RegExp(`^${ls.message}`)) as HTMLTextAreaElement).value).toBe("Call IT");
    // Nothing changed: no update to send.
    expect((within(card).getByRole("button", { name: ls.update }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: ls.unlock }));
    const dialog = screen.getByRole("dialog");
    expect(unlock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: ls.unlock }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith({ deviceId: "d1" }));
    expect(await screen.findByText(ls.unlocked_ok)).toBeTruthy();
  });

  it("a viewer sees the lock and its text but no form and no buttons; a revoked PC cannot be locked", () => {
    ui(<LockCard d={device({ lock: { lockId: "l1", message: "Call IT", lockedAt: NOW } })} />, "viewer");
    expect(screen.getByText(ls.locked)).toBeTruthy();
    expect(screen.getByText("Call IT")).toBeTruthy();
    expect(screen.queryByRole("button", { name: ls.unlock })).toBeNull();
    expect(screen.queryByRole("button", { name: ls.lock })).toBeNull();
    cleanup();
    ui(<LockCard d={device({ revoked: true })} />, "admin");
    expect(screen.getByText(ls.revokedNote)).toBeTruthy();
    expect(screen.queryByRole("button", { name: ls.lock })).toBeNull();
  });
});

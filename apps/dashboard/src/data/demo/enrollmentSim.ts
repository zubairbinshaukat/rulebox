/**
 * The demo's "new PC joins" (UI pass, enrollment plan 6): a code made in the demo has no real PC behind it, so each created code gets
 * one simulated PC that walks through what a real one does, on timers (6 s: joins, a device row and a use of the code; 8 s: online;
 * 10 s: the kiosk starts applying; 14 s: applied). Demo only (`VITE_DEMO=1`): a live build never imports this file.
 *
 * Timers are cleared when the code is revoked and when the demo data is reset. A code that is revoked, used up or expired when the
 * first timer fires gets no PC. The tests use fake timers (`vi.useFakeTimers()`).
 */
import { pingIntervalFor, type DbDevice } from "../fixtures/seed";
import { db as getDb, newId, onDemoReset, touch } from "./store";

/** Milliseconds after the code was made. */
export const DEMO_PC_TIMELINE = { joins: 6_000, online: 8_000, applying: 10_000, applied: 14_000 } as const;

const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
/** Demo PCs by the code (row id) they joined with, oldest first. */
const joinedBy = new Map<string, string[]>();
let counter = 0;

onDemoReset(() => {
  for (const list of timers.values()) for (const t of list) clearTimeout(t);
  timers.clear();
  joinedBy.clear();
  counter = 0;
});

/** The simulated PCs that joined with this code (device ids, oldest first). */
export function simulatedPcIds(tokenId: string): string[] {
  return [...(joinedBy.get(tokenId) ?? [])];
}

/** Cancels what has not happened yet for this code (a revoked code stops growing; a PC that already joined stays as it is). */
export function stopSimulation(tokenId: string): void {
  for (const t of timers.get(tokenId) ?? []) clearTimeout(t);
  timers.delete(tokenId);
}

/** Starts the simulated PC of a new code. */
export function simulatePcFor(tokenId: string): void {
  stopSimulation(tokenId);
  let deviceId: string | null = null;
  const at = (ms: number, step: () => void) => setTimeout(() => step(), ms);

  const join = () => {
    const db = getDb();
    const now = Date.now();
    const code = db.tokens.find((t) => t._id === tokenId);
    if (!code || code.revoked || code.usesLeft <= 0 || code.expiresAt <= now) return;
    counter += 1;
    const name = `DEMO-PC-${String(counter).padStart(2, "0")}`;
    const device: DbDevice = {
      _id: newId("dev"),
      name,
      groupId: code.groupId,
      revoked: false,
      kioskEnabled: true,
      enrolledAt: now,
      revision: 0,
      rotateCredential: false,
    };
    deviceId = device._id;
    db.devices.push(device);
    // As a real enrollment: a first report without a kiosk phase, one version of the group's settings, a row in the audit log.
    db.reports.set(device._id, { agentVersion: "0.4.1", outOfSupport: false, updatedAt: now });
    db.lastSeen.set(device._id, now);
    db.versions.set(device._id, [{ version: 1, createdAt: now, reason: "key registered" }]);
    code.usesLeft -= 1;
    joinedBy.set(tokenId, [...(joinedBy.get(tokenId) ?? []), device._id]);
    db.audit.push({
      _id: newId("aud"),
      at: now,
      actorType: "device",
      actorId: device._id,
      actorLabel: name,
      action: "device.enrolled",
      targetType: "device",
      targetId: device._id,
      targetLabel: name,
      summary: code.label ? `Enrolled the PC ${name} with the enrollment code ${code.label}` : `Enrolled the PC ${name} with an enrollment code`,
    });
    db.pingIntervalMs = pingIntervalFor(db.devices.filter((d) => !d.revoked).length);
    touch();
  };

  const withDevice = (change: (id: string) => void) => () => {
    if (deviceId === null) return;
    const db = getDb();
    if (!db.devices.some((d) => d._id === deviceId && !d.revoked)) return;
    change(deviceId);
    touch();
  };

  timers.set(tokenId, [
    at(DEMO_PC_TIMELINE.joins, join),
    at(
      DEMO_PC_TIMELINE.online,
      withDevice((id) => {
        const db = getDb();
        db.onlineIds.add(id);
        db.lastSeen.set(id, Date.now());
      }),
    ),
    at(
      DEMO_PC_TIMELINE.applying,
      withDevice((id) => {
        const report = getDb().reports.get(id);
        if (report) report.kioskPhase = "applying";
      }),
    ),
    at(
      DEMO_PC_TIMELINE.applied,
      withDevice((id) => {
        const report = getDb().reports.get(id);
        if (report) {
          report.kioskPhase = "applied";
          report.appliedVersion = 1;
        }
      }),
    ),
  ]);
}

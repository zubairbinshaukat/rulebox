import type { PillTone } from "@rulebox/ui";
import type { DeviceLiveness, DevicePage } from "../../data/types";
import { formatDateTimeLong, formatRelative } from "../../lib/format";
import { deviceText as t } from "./strings";

export interface Presence {
  tone: PillTone;
  label: string;
  /** The exact time, for the hover. */
  title?: string;
}

const SOON_MS = 45_000;

const relative = (ms: number, now: number) => (Math.abs(now - ms) < SOON_MS ? t.justNow : formatRelative(ms, now));

/**
 * The presence pill: "Online · 2 minutes ago" (the liveness row's last contact), "Offline · since 3 days ago", "Not connected yet".
 * A liveness query that has not answered (or failed) adds nothing and never says "Not connected yet" (that is only for a PC the
 * server says never pinged).
 */
export function presenceOf(d: Pick<DevicePage, "presence">, live: DeviceLiveness | null, now: number): Presence {
  const { online, since } = d.presence;
  const contact = live?.lastContactAt ?? null;
  const exact = since === null ? undefined : formatDateTimeLong(since);
  if (online) return { tone: "success", label: contact === null ? t.online : t.onlineAgo(relative(contact, now)), title: exact };
  if (since !== null) return { tone: "neutral", label: t.offlineSince(relative(since, now)), title: exact };
  if (contact !== null) return { tone: "neutral", label: t.offlineLastSeen(relative(contact, now)), title: formatDateTimeLong(contact) };
  if (live !== null) return { tone: "neutral", label: t.notConnected };
  return { tone: "neutral", label: t.offline };
}

export function kioskPillOf(d: Pick<DevicePage, "revoked" | "kioskEnabled" | "report">): { tone: PillTone; label: string } {
  if (d.revoked) return { tone: "danger", label: t.disconnected };
  if (!d.kioskEnabled) return { tone: "warning", label: t.kioskOff };
  switch (d.report?.kioskPhase) {
    case "applied":
      return { tone: "success", label: t.kioskOn };
    case "failed":
      return { tone: "danger", label: t.kioskProblem };
    case "applying":
      return { tone: "neutral", label: t.kioskStarting };
    default:
      return { tone: "neutral", label: t.kioskWaiting };
  }
}

import { lazy, Suspense, useState, type RefObject } from "react";
import { Link } from "react-router";
import { Button, IconButton, InfoTip, Pill } from "@rulebox/ui";
import IconBack from "~icons/solar/alt-arrow-left-linear";
import IconBell from "~icons/solar/bell-linear";
import IconLock from "~icons/solar/lock-linear";
import IconUnlock from "~icons/solar/lock-unlocked-linear";
import IconPen from "~icons/solar/pen-linear";
import type { DeviceLiveness, DevicePage } from "../../data/types";
import { RoleGate } from "../../components/RoleGate";
import { windowsName } from "./format";
import { kioskPillOf, presenceOf } from "./presence";
import { deviceText as t } from "./strings";

// The dialogs load when they are opened (the page opens on the Overview and most visits never lock, rename or message).
const SendBroadcastDialog = lazy(() => import("../broadcasts/SendDialog").then((m) => ({ default: m.SendBroadcastDialog })));
const LockDialog = lazy(() => import("./LockDialog").then((m) => ({ default: m.LockDialog })));
const RenameDialog = lazy(() => import("./RenameDialog").then((m) => ({ default: m.RenameDialog })));

/**
 * The top of the device page, the same on every tab (plan 4): the name with a pen, the two states you ask first (online, kiosk), what
 * it is (group, Windows, Rulebox version) and the two things you do from anywhere (send a message, lock). On a wide header the
 * actions sit right of the name; on a phone they are a 50/50 row under it. The name is the page's one `h1`.
 */
export function DeviceHeader({ d, live, now, titleRef }: { d: DevicePage; live: DeviceLiveness | null; now: number; titleRef: RefObject<HTMLHeadingElement | null> }) {
  const [renaming, setRenaming] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const [locking, setLocking] = useState(false);
  const presence = presenceOf(d, live, now);
  const kiosk = kioskPillOf(d);
  const windows = windowsName(d.report);
  const agent = d.report?.agentVersion;
  const locked = d.lock !== null;

  return (
    <header className="dev-head">
      <Link to="/devices" className="dash-head__back">
        <IconBack aria-hidden="true" />
        {t.back}
      </Link>
      <div className="dev-head__grid">
        <div className="dev-head__id">
          <div className="dev-head__title">
            <h1 ref={titleRef} className="dev-head__name" title={d.name} tabIndex={-1} data-page-title>
              {d.name}
            </h1>
            <RoleGate minRole="admin">
              <IconButton label={t.rename} size={32} className="dev-head__pen" onClick={() => setRenaming(true)}>
                <IconPen aria-hidden="true" />
              </IconButton>
            </RoleGate>
          </div>
          <div className="dev-head__pills">
            <Pill tone={presence.tone} dot title={presence.title}>
              {presence.label}
            </Pill>
            <InfoTip label={t.onlineInfoLabel}>{t.onlineInfo}</InfoTip>
            <Pill tone={kiosk.tone} dot>
              {kiosk.label}
            </Pill>
            {locked ? <Pill tone="danger">{t.locked}</Pill> : null}
          </div>
          <ul className="dev-head__meta" aria-label={t.metaLabel}>
            <li>
              {d.group ? (
                <>
                  {t.groupLabel} <Link to={`/groups/${d.group._id}`}>{d.group.name}</Link>
                </>
              ) : (
                t.noGroup
              )}
            </li>
            {windows ? <li>{windows}</li> : null}
            {agent ? <li>{t.rulebox(agent)}</li> : null}
          </ul>
        </div>
        {d.revoked ? null : (
          <RoleGate minRole="admin">
            <div className="dev-head__actions">
              <Button variant="ghost" onClick={() => setMessaging(true)}>
                <IconBell aria-hidden="true" />
                {t.sendMessage}
              </Button>
              <Button variant={locked ? "danger-ghost" : "ghost"} onClick={() => setLocking(true)}>
                {locked ? <IconUnlock aria-hidden="true" /> : <IconLock aria-hidden="true" />}
                {locked ? t.unlockPc : t.lockPc}
              </Button>
            </div>
          </RoleGate>
        )}
      </div>
      <Suspense fallback={null}>
        {renaming ? <RenameDialog d={d} open onClose={() => setRenaming(false)} /> : null}
        {messaging ? <SendBroadcastDialog open target={{ kind: "device", id: d._id, name: d.name }} onClose={() => setMessaging(false)} /> : null}
        {locking ? <LockDialog d={d} open onClose={() => setLocking(false)} /> : null}
      </Suspense>
    </header>
  );
}

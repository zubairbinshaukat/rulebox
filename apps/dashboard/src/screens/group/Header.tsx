import { lazy, Suspense, useState, type RefObject } from "react";
import { Link } from "react-router";
import { Button } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-circle-linear";
import IconBack from "~icons/solar/alt-arrow-left-linear";
import IconBell from "~icons/solar/bell-linear";
import IconPen from "~icons/solar/pen-linear";
import IconRocket from "~icons/solar/rocket-2-linear";
import IconShield from "~icons/solar/shield-check-linear";
import IconTrash from "~icons/solar/trash-bin-trash-linear";
import type { GroupDetail } from "../../data/types";
import { MoreMenu, type MoreMenuItem } from "../../components/MoreMenu";
import { RoleGate } from "../../components/RoleGate";
import { useCan } from "../../lib/member";
import { groupPage as t } from "./strings";

// The dialogs load when they are opened: most visits never rename, delete or send a message.
const SendBroadcastDialog = lazy(() => import("../broadcasts/SendDialog").then((m) => ({ default: m.SendBroadcastDialog })));
const RenameDialog = lazy(() => import("./RenameDialog").then((m) => ({ default: m.RenameDialog })));
const DeleteDialog = lazy(() => import("./DeleteDialog").then((m) => ({ default: m.DeleteDialog })));

/**
 * The top of the group page, the same on every tab (plan 1.4): the name and what the group is for, the one thing you do here
 * (Assign app), a way to the group's protection, and a "more" menu for the rare things (Staged rollout, Send a message, Rename,
 * Delete last). On a wide header the buttons sit right of the name; on a phone they are one row under it.
 */
export function GroupHeader({
  g,
  titleRef,
  actionsRef,
  onAssign,
}: {
  g: GroupDetail;
  titleRef: RefObject<HTMLHeadingElement | null>;
  /** The row of buttons: when it has scrolled away a phone shows the main button at the bottom of the screen. */
  actionsRef: RefObject<HTMLDivElement | null>;
  onAssign: () => void;
}) {
  const admin = useCan("admin");
  const [dialog, setDialog] = useState<"rename" | "delete" | "message" | null>(null);

  const items: MoreMenuItem[] = [
    // Everyone may look at the rollout; only admins change it (the screen decides).
    { label: t.stagedRollout, icon: <IconRocket aria-hidden="true" />, to: `/groups/${g._id}/rollout` },
    { label: t.sendMessage, icon: <IconBell aria-hidden="true" />, onSelect: () => setDialog("message"), hidden: !admin },
    { label: t.rename, icon: <IconPen aria-hidden="true" />, onSelect: () => setDialog("rename"), hidden: !admin },
    { label: t.deleteGroup, icon: <IconTrash aria-hidden="true" />, onSelect: () => setDialog("delete"), danger: true, hidden: !admin },
  ];

  return (
    <header className="grp-head">
      <Link to="/groups" className="dash-head__back">
        <IconBack aria-hidden="true" />
        {t.back}
      </Link>
      <div className="grp-head__grid">
        <div className="grp-head__id">
          <h1 ref={titleRef} className="grp-head__name" title={g.name} tabIndex={-1} data-page-title>
            {g.name}
          </h1>
          {g.description ? <p className="grp-head__lead">{g.description}</p> : null}
        </div>
        <div ref={actionsRef} className="grp-head__actions">
          <RoleGate minRole="admin">
            <Button variant="primary" className="grp-head__main" onClick={onAssign}>
              <IconAdd aria-hidden="true" />
              {t.assignApp}
            </Button>
          </RoleGate>
          <Link className="rb-btn rb-btn--ghost" to={`/groups/${g._id}/lockdown`}>
            <IconShield aria-hidden="true" />
            {t.protection}
          </Link>
          <MoreMenu items={items} label={t.more} />
        </div>
      </div>
      <Suspense fallback={null}>
        {dialog === "rename" ? <RenameDialog g={g} onClose={() => setDialog(null)} /> : null}
        {dialog === "delete" ? <DeleteDialog g={g} onClose={() => setDialog(null)} /> : null}
        {dialog === "message" ? <SendBroadcastDialog open target={{ kind: "group", id: g._id, name: g.name }} onClose={() => setDialog(null)} /> : null}
      </Suspense>
    </header>
  );
}

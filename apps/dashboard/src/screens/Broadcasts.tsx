import { useMemo, useState } from "react";
import { Button, Pill } from "@rulebox/ui";
import IconBell from "~icons/solar/bell-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useBroadcastsPage, useCancelBroadcast } from "../data";
import type { BroadcastRow } from "../data/types";
import type { Column } from "../components/DataTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { formatDateTime } from "../lib/format";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { useCan } from "../lib/member";
import { ackRatio, broadcastStatus } from "../lib/noticeRules";
import { useNow } from "../lib/useNow";
import { useToast } from "../lib/toast";
import { SendBroadcastDialog } from "./broadcasts/SendDialog";
import { broadcastStrings as s } from "./broadcasts/strings";

/** `broadcasts:list` sorts by "sent" only, newest first; no search and no total (the pager shows Previous / Next and "Page N"). */
const LIST: ListConfig = { sorts: ["sent"], defaultSort: { key: "sent", dir: "desc" } };

/**
 * The Broadcasts screen (plan 4.17): messages sent to a group or one PC with their status and how many PCs acknowledged them
 * ("14 of 20 PCs", never who). Admins send and cancel; viewers read.
 */
export default function Broadcasts() {
  const paging = useListPaging(useListView(LIST), { total: null });
  const page = useBroadcastsPage(paging.query);
  const now = useNow(30_000);
  const canAct = useCan("admin");
  const toast = useToast();
  const cancel = useCancelBroadcast();
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState<BroadcastRow | null>(null);

  const cols = useMemo<Column<BroadcastRow>[]>(
    () => [
      {
        key: "message",
        header: s.colMessage,
        primary: true,
        cell: (b) => (
          <span className="dash-cell-stack" style={{ maxWidth: 360 }}>
            <strong className="dash-wrap" style={{ fontWeight: 600 }}>
              {b.title}
            </strong>
            <span className="dash-cell-sub dash-wrap">{b.body}</span>
            <span className="dash-cell-sub">
              {s.styles[b.style]} · {b.expiresAt === null ? s.noExpiry : s.expiresAt(formatDateTime(b.expiresAt))}
            </span>
          </span>
        ),
      },
      {
        key: "target",
        header: s.colTarget,
        cell: (b) => (
          <span className="dash-cell-stack">
            <span className="dash-truncate" style={{ maxWidth: 200 }}>
              {b.target.name ?? s.gone}
            </span>
            <span className="dash-cell-sub">{s.kinds[b.target.kind]}</span>
          </span>
        ),
      },
      {
        key: "sent",
        header: s.colSent,
        sortable: true,
        sortDefaultDir: "desc",
        cell: (b) => <RelativeTime ms={b.createdAt} />,
      },
      {
        key: "status",
        header: s.colStatus,
        cell: (b) => {
          const st = broadcastStatus(b, now);
          return <Pill tone={s.statusTones[st]}>{s.statuses[st]}</Pill>;
        },
      },
      {
        key: "acks",
        header: s.colAcks,
        isEmpty: (b) => !b.ackRequired,
        cell: (b) => {
          if (!b.ackRequired) return <span className="dash-muted">{s.noAckNeeded}</span>;
          const r = ackRatio(b);
          return s.acks(r.acked, r.of);
        },
      },
      {
        key: "actions",
        header: s.colActions,
        actions: true,
        isEmpty: (b) => !canAct || broadcastStatus(b, now) !== "active",
        cell: (b) =>
          canAct && broadcastStatus(b, now) === "active" ? (
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setCancelling(b)}>
              {s.cancel}
            </Button>
          ) : null,
      },
    ],
    [now, canAct],
  );

  return (
    <div className="dash-page">
      <PageHeader
        title={s.title}
        lead={s.lead}
        actions={
          <RoleGate minRole="admin">
            <Button onClick={() => setSending(true)}>
              <IconAdd aria-hidden="true" />
              {s.send}
            </Button>
          </RoleGate>
        }
      />
      <SendBroadcastDialog open={sending} target={{ kind: "group" }} onClose={() => setSending(false)} />
      <ConfirmDialog
        open={cancelling !== null}
        title={s.cancelTitle(cancelling?.title ?? "")}
        body={s.cancelBody}
        confirmLabel={s.cancel}
        onConfirm={() => cancel({ id: cancelling?._id ?? "" })}
        onDone={() => toast(s.cancelled)}
        onClose={() => setCancelling(null)}
      />
      <ServerTable<BroadcastRow>
        framed
        caption={s.title}
        columns={cols}
        getKey={(b) => b._id}
        paging={paging}
        list={page}
        total={null}
        skeletonRows={6}
        empty={<EmptyState icon={<IconBell />} title={s.emptyTitle} body={s.emptyBody} />}
      />
    </div>
  );
}
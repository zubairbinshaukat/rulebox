import { useMemo, useState } from "react";
import { Button, InfoTip, Pill } from "@rulebox/ui";
import IconBell from "~icons/solar/bell-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useBroadcastsPage, useCancelBroadcast } from "../data";
import type { BroadcastRow } from "../data/types";
import type { Column, RowAction } from "../components/DataTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { TruncateLazy as Truncate } from "../components/TruncateLazy";
import { formatDateTime } from "../lib/format";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { useCan } from "../lib/member";
import { ackRatio, broadcastStatus } from "../lib/noticeRules";
import { useNow } from "../lib/useNow";
import { useToast } from "../lib/toast";
import { LiveNow } from "./broadcasts/LiveNow";
import { SendBroadcastDialog } from "./broadcasts/SendDialog";
import { broadcastStrings as s } from "./broadcasts/strings";
import "./broadcasts/broadcasts.css";

/** `broadcasts:list` sorts by "sent" only, newest first; no search and no total (the pager shows Previous / Next and "Page N"). */
const LIST: ListConfig = { sorts: ["sent"], defaultSort: { key: "sent", dir: "desc" } };

/** "Banner · Until 3 Dec, 14:00". */
const howOf = (b: BroadcastRow) => `${s.styles[b.style]} · ${b.expiresAt === null ? s.noExpiry : s.expiresAt(formatDateTime(b.expiresAt))}`;

/**
 * The Messages screen (plan 4.17, UI pass `other-pages.md` section 5): "On your PCs now" (what is showing at this moment), then every
 * message sent to a group or one PC with its status and how many PCs saw it ("14 of 20 PCs", never who). Admins send and cancel;
 * viewers read. On a wide screen the live messages sit beside the list instead of above it.
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

  const cols = useMemo<Column<BroadcastRow>[]>(() => {
    const actionsOf = (b: BroadcastRow): RowAction[] =>
      canAct && broadcastStatus(b, now) === "active" ? [{ label: s.cancelRow, onSelect: () => setCancelling(b) }] : [];
    return [
      {
        key: "message",
        header: s.colMessage,
        primary: true,
        type: "text",
        maxWidth: 340,
        cell: (b) => (
          <span className="dash-cell-stack">
            <strong className="bc-cell__title">
              <Truncate lines={1}>{b.title}</Truncate>
            </strong>
            <span className="dash-cell-sub">
              <Truncate lines={2}>{b.body}</Truncate>
            </span>
            <span className="dash-cell-sub">{howOf(b)}</span>
          </span>
        ),
        cardCell: (b) => b.title,
        cardSub: (b) => <Truncate lines={2}>{b.body}</Truncate>,
      },
      {
        key: "status",
        header: s.colStatus,
        type: "badge",
        card: "status",
        cell: (b) => {
          const st = broadcastStatus(b, now);
          return <Pill tone={s.statusTones[st]}>{s.statuses[st]}</Pill>;
        },
      },
      {
        key: "target",
        header: s.colTarget,
        type: "name",
        maxWidth: 200,
        card: "fact",
        cardLabel: s.colSentTo,
        cell: (b) => (
          <span className="dash-cell-stack">
            <Truncate lines={1}>{b.target.name ?? s.gone}</Truncate>
            <span className="dash-cell-sub">{s.kinds[b.target.kind]}</span>
          </span>
        ),
        cardCell: (b) => `${b.target.name ?? s.gone} · ${s.kinds[b.target.kind]}`,
      },
      {
        key: "sent",
        header: s.colSent,
        type: "date",
        sortable: true,
        sortDefaultDir: "desc",
        card: "fact",
        cell: (b) => <RelativeTime ms={b.createdAt} />,
      },
      {
        key: "acks",
        header: s.colAcks,
        type: "short",
        card: "fact",
        cell: (b) => {
          if (!b.ackRequired) return <span className="dash-muted">—</span>;
          const r = ackRatio(b);
          return s.acks(r.acked, r.of);
        },
        // On a card the words say why there is no number; in the table a dash does.
        cardCell: (b) => {
          if (!b.ackRequired) return s.noAckNeeded;
          const r = ackRatio(b);
          return s.acks(r.acked, r.of);
        },
      },
      // Card only: the table already shows the style and the end under the message.
      { key: "how", header: s.colHow, table: false, card: "detail", cardLabel: false, cell: howOf },
      { key: "actions", header: s.colActions, actions: true, rowActions: actionsOf, isEmpty: (b) => actionsOf(b).length === 0, cell: () => null },
    ];
  }, [now, canAct]);

  const listEmpty = page.status === "ready" && page.items.length === 0;

  return (
    <div className="dash-page bc-page">
      <PageHeader
        title={s.title}
        lead={
          <>
            {s.lead} <InfoTip label={s.leadInfoLabel}>{s.leadInfo}</InfoTip>
          </>
        }
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
      <div className="bc-grid">
        <div className="bc-grid__live">
          <LiveNow now={now} hideIfNone={listEmpty} onCancel={canAct ? setCancelling : undefined} />
        </div>
        <div className="bc-grid__list">
          <ServerTable<BroadcastRow>
            framed
            caption={s.title}
            columns={cols}
            getKey={(b) => b._id}
            rowLabel={(b) => b.title}
            paging={paging}
            list={page}
            total={null}
            skeletonRows={6}
            empty={<EmptyState icon={<IconBell />} title={s.emptyTitle} body={s.emptyBody} />}
          />
        </div>
      </div>
    </div>
  );
}

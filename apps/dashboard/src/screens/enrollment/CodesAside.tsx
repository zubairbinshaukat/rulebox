import { useId, useMemo, type Ref } from "react";
import { Button, Pill, type PillTone } from "@rulebox/ui";
import { useEnrollmentScreen } from "../../data/enrollment";
import type { EnrollmentCodeRow, EnrollmentCodeState } from "../../data/types";
import type { Column } from "../../components/DataTable";
import { RelativeTime } from "../../components/RelativeTime";
import { ServerTable } from "../../components/ServerTable";
import { useListPaging, useListView, type ListConfig } from "../../lib/listView";
import { strings } from "../../lib/strings";
import { useMinute, useNow } from "../../lib/useNow";
import { displayState } from "./model";
import { enrollText as s } from "./strings";

const TONE: Record<EnrollmentCodeState, PillTone> = { active: "success", usedUp: "neutral", expired: "warning", revoked: "danger" };

/** `enrollmentCodes:list` sort keys; the first is the default (newest first). No search and no total. */
const LIST: ListConfig = { sorts: ["created", "expires"], defaultSort: { key: "created", dir: "desc" } };

export interface CodesAsideProps {
  canAct: boolean;
  onRevoke: (row: EnrollmentCodeRow) => void;
  /** "See progress": the wizard watches this code (without showing it). */
  onWatch: (row: EnrollmentCodeRow) => void;
  /** The heading is a focus target: "See your codes" moves here. */
  headingRef: Ref<HTMLHeadingElement>;
}

/**
 * "Your codes": `enrollmentCodes:list`, one page of ten at a time, always as cards (the side column is too narrow for a table). `nowMs`
 * is the minute, so the subscription changes at most once a minute; each card's state and buttons keep ticking on their own clock.
 */
export function CodesAside({ canAct, onRevoke, onWatch, headingRef }: CodesAsideProps) {
  const titleId = useId();
  const minute = useMinute();
  const view = useListView(LIST);
  const paging = useListPaging(view, { total: null });
  const codes = useEnrollmentScreen(minute, paging.query);

  const cols = useMemo<Column<EnrollmentCodeRow>[]>(
    () => [
      {
        key: "label",
        header: s.colLabel,
        primary: true,
        cell: (c) => <span className={c.label ? "" : "dash-muted"}>{c.label ?? s.unlabeled}</span>,
        cardSub: (c) => (c.groupId && c.groupName ? c.groupName : c.groupId ? s.groupGone : null),
      },
      { key: "state", header: s.colState, type: "badge", card: "status", cell: (c) => <StateCell row={c} /> },
      { key: "uses", header: s.colUses, type: "short", cardLabel: false, cell: (c) => <span>{s.used(Math.max(0, c.usesTotal - c.usesLeft), c.usesTotal)}</span> },
      { key: "expires", header: s.colExpires, type: "date", sortable: true, sortDefaultDir: "desc", cell: (c) => <RelativeTime ms={c.expiresAt} /> },
      { key: "created", header: s.colCreated, type: "date", sortable: true, sortDefaultDir: "desc", card: "hidden", cell: (c) => <RelativeTime ms={c.createdAt} /> },
      {
        key: "act",
        header: strings.common.actions,
        actions: true,
        isEmpty: (c) => c.state !== "active" && c.usesTotal - c.usesLeft === 0,
        cell: (c) => <CodeButtons row={c} canAct={canAct} onRevoke={onRevoke} onWatch={onWatch} />,
      },
    ],
    [canAct, onRevoke, onWatch],
  );

  return (
    <section className="dash-card addpc-aside" aria-labelledby={titleId}>
      <div className="dash-card__head">
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="dash-card__title addpc-aside__title">
          {s.aside}
        </h2>
      </div>
      <div className="addpc-aside__body">
        <ServerTable<EnrollmentCodeRow>
          caption={s.listCaption}
          columns={cols}
          getKey={(c) => c._id}
          isDim={(c) => c.state !== "active"}
          paging={paging}
          list={codes}
          total={null}
          view="cards"
          skeletonRows={3}
          empty={<p className="addpc-aside__empty">{s.emptyTitle}</p>}
        />
      </div>
    </section>
  );
}

/** Colour and text; re-renders on its own clock (30 s), not the list's. */
function StateCell({ row }: { row: EnrollmentCodeRow }) {
  const state = displayState(row, useNow(30_000));
  return (
    <Pill tone={TONE[state]} dot>
      {s.states[state]}
    </Pill>
  );
}

function CodeButtons({ row, canAct, onRevoke, onWatch }: { row: EnrollmentCodeRow; canAct: boolean; onRevoke: (row: EnrollmentCodeRow) => void; onWatch: (row: EnrollmentCodeRow) => void }) {
  const state = displayState(row, useNow(30_000));
  const name = row.label ?? s.unlabeled;
  const watchable = state === "active" || row.usesTotal - row.usesLeft > 0;
  return (
    <>
      {watchable ? (
        <Button variant="ghost" className="dash-btn--sm" onClick={() => onWatch(row)} aria-label={s.seeProgressNamed(name)}>
          {s.seeProgress}
        </Button>
      ) : null}
      {canAct && state === "active" ? (
        <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => onRevoke(row)} aria-label={s.revokeNamed(name)}>
          {strings.common.revoke}
        </Button>
      ) : null}
    </>
  );
}

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { InfoTip, Pill } from "@rulebox/ui";
import IconShield from "~icons/solar/shield-check-linear";
import { useFindingsPage, useIgnoreFinding } from "../data/lockdown";
import { FINDING_STATUSES, type FindingRow, type FindingStatus } from "../data/types";
import type { Column, RowAction } from "../components/DataTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { PageTabPanel, PageTabs } from "../components/PageTabs";
import { RelativeTime } from "../components/RelativeTime";
import { ServerTable } from "../components/ServerTable";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { allowKinds } from "./lockdown/rules";
import { useCan } from "../lib/member";
import { useToast } from "../lib/toast";
import { AllowDialog } from "./lockdown/AllowDialog";
import { findingsStrings as s, lockdownErrorMessage } from "./lockdown/strings";
import "./lockdown/lockdown.css";

/** `lockdown:findings` sorts by "seen" only (last seen first); the status tab is the `status` parameter. No search, no total. */
const LIST: ListConfig = { sorts: ["seen"], defaultSort: { key: "seen", dir: "desc" }, filters: ["status"] };

const ID_BASE = "findings";

/** The program: its name, who made it ("Unknown publisher" when it is not signed) and, for the Windows safety list, why it has no Allow. */
function ProgramSub({ f }: { f: FindingRow }) {
  return (
    <span className="lk-prog__sub">
      {f.signer === null ? (
        <>
          <Pill tone="warning">{s.unsigned}</Pill>
          <InfoTip label={`About ${s.unsigned}`}>{s.unsignedInfo}</InfoTip>
        </>
      ) : (
        <span>{f.signer}</span>
      )}
      {f.product ? <span className="lk-prog__prod">{f.product}</span> : null}
      {f.layer === "appControl" ? (
        <>
          <Pill tone="neutral">{s.appControlNote}</Pill>
          <InfoTip label={`About ${s.appControlNote}`}>{s.appControlInfo}</InfoTip>
        </>
      ) : null}
    </span>
  );
}

/** The three steps of a review, as a card on the side (laptop), a strip above the list (tablet) or an (i) next to the title (phone). */
function HowToReview() {
  return (
    <section className="dash-card lk-how" aria-labelledby="lk-how-title">
      <h2 id="lk-how-title" className="lk-how__title">
        {s.howTitle}
      </h2>
      <ol className="lk-how__steps">
        {s.howSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </section>
  );
}

/**
 * `/lockdown/findings` (UI pass, "Programs to review"): the programs the rules blocked or would block in a trial run, one row per
 * program, in three tabs (To review, Allowed, Ignored; the tab is `?status=`). Never a full path, a command line or which PCs. Admins
 * allow (an exception) or ignore; viewers read. `?group=` comes from the group's lockdown page: the Allow dialog preselects that group
 * and the title links back to it.
 */
export default function Findings() {
  const view = useListView(LIST);
  const [params] = useSearchParams();
  const groupId = params.get("group");
  const wanted = view.filters.status;
  const status: FindingStatus = (FINDING_STATUSES as readonly string[]).includes(wanted ?? "") ? (wanted as FindingStatus) : "new";
  const paging = useListPaging(view, { total: null });
  const page = useFindingsPage({ ...paging.query, status });
  const canAct = useCan("admin");
  const toast = useToast();
  const ignore = useIgnoreFinding();
  const [allowing, setAllowing] = useState<FindingRow | null>(null);
  const [ignoring, setIgnoring] = useState<FindingRow | null>(null);

  const cols = useMemo<Column<FindingRow>[]>(() => {
    const actionsOf = (f: FindingRow): RowAction[] => {
      if (!canAct || f.status === "allowed") return [];
      const out: RowAction[] = [];
      // The Windows safety list cannot be allowed one by one: only Ignore (the (i) next to the name says why).
      if (f.layer !== "appControl") {
        const none = allowKinds(f).length === 0;
        out.push({ label: s.allow, onSelect: () => setAllowing(f), primary: true, disabled: none, hint: none ? s.errors.no_hash : undefined });
      }
      if (f.status === "new") out.push({ label: s.ignore, onSelect: () => setIgnoring(f) });
      return out;
    };
    return [
      {
        key: "program",
        header: s.colProgram,
        primary: true,
        cell: (f) => (
          <span className="lk-prog">
            <strong className="lk-prog__name" title={f.fileName}>{f.fileName}</strong>
            <ProgramSub f={f} />
            <span className="lk-prog__where">{s.folders[f.folderClass] ?? s.folders.other}</span>
          </span>
        ),
        maxWidth: 220,
        cardCell: (f) => f.fileName,
        cardSub: (f) => <ProgramSub f={f} />,
      },
      { key: "where", header: s.colWhere, type: "short", cell: (f) => s.folders[f.folderClass] ?? s.folders.other },
      { key: "devices", header: s.colDevices, type: "short", cell: (f) => s.pcs(f.deviceCount) },
      { key: "seen", header: s.colSeen, type: "date", sortable: true, sortDefaultDir: "desc", cell: (f) => <RelativeTime ms={f.lastSeenAt} /> },
      { key: "actions", header: s.colActions, actions: true, rowActions: actionsOf, isEmpty: (f) => actionsOf(f).length === 0, cell: () => null },
    ];
  }, [canAct]);

  const tabs = FINDING_STATUSES.map((id) => ({ id, label: s.statuses[id] }));

  return (
    <div className="dash-page">
      <PageHeader
        title={s.title}
        lead={s.lead}
        back={groupId ? { to: `/groups/${encodeURIComponent(groupId)}/lockdown`, label: s.backToLockdown } : undefined}
        actions={
          <span className="lk-howtip">
            <InfoTip label={`About ${s.howTitle}`}>
              <ol className="lk-tiplist">
                {s.howSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </InfoTip>
          </span>
        }
      />
      <AllowDialog finding={allowing} defaultGroupId={groupId} onClose={() => setAllowing(null)} />
      <ConfirmDialog
        open={ignoring !== null}
        title={s.ignoreTitle(ignoring?.fileName ?? "")}
        body={s.ignoreBody}
        confirmLabel={s.ignore}
        onConfirm={() => ignore({ findingId: ignoring?._id ?? "" })}
        onDone={() => toast(s.ignored)}
        onClose={() => setIgnoring(null)}
        describeError={lockdownErrorMessage}
      />
      <div className="lk-find">
        <div className="lk-find__main">
          <PageTabs tabs={tabs} value={status} onChange={(id) => view.setFilter("status", id === "new" ? null : id)} aria-label={s.tabsLabel} idBase={ID_BASE}>
            <PageTabPanel idBase={ID_BASE} id={status}>
              <ServerTable<FindingRow>
                framed
                caption={s.title}
                columns={cols}
                getKey={(f) => f._id}
                rowLabel={(f) => f.fileName}
                paging={paging}
                list={page}
                total={null}
                skeletonRows={6}
                empty={<EmptyState icon={<IconShield />} title={s.emptyTitle[status]} body={s.emptyBody[status]} />}
              />
            </PageTabPanel>
          </PageTabs>
        </div>
        <aside className="lk-find__aside">
          <HowToReview />
        </aside>
      </div>
    </div>
  );
}

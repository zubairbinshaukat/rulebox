import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { Button, InfoTip, SegmentedControl } from "@rulebox/ui";
import IconHistory from "~icons/solar/history-linear";
import IconPrinter from "~icons/solar/printer-minimalistic-linear";
import IconFilter from "~icons/solar/filter-linear";
import IconClose from "~icons/solar/close-circle-linear";
import { useAuditScreen } from "../data/audit";
import type { AuditEntry } from "../data/types";
import { ActorLabel, TargetLink } from "../components/AuditItem";
import { actionLabel } from "../lib/audit";
import { actorKind, plainSummary } from "../lib/auditText";
import type { Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { ServerTable } from "../components/ServerTable";
import { formatDateTime, timeZoneName } from "../lib/format";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { auditStrings } from "../lib/screenStrings/audit";
import { parseWhen, sinceFor, WHEN_CHOICES, type When } from "./audit/since";
import "./audit/audit.css";

const s = auditStrings;

/**
 * `audit:list` sorts by time ("at") only, newest first. No search and no total. The filters live in the URL: `since`
 * (today, 7d, 30d) and `about` + `label` (one item's id and its name, for the chip).
 */
const LIST: ListConfig = { sorts: ["at"], defaultSort: { key: "at", dir: "desc" }, filters: ["since", "about", "label"] };

/** The longest item name kept in the address (the chip cuts it with an ellipsis anyway). */
const LABEL_MAX = 80;

/**
 * `audit:list` (or `audit:forTarget` with "Only this"), one page at a time (page, page size, sort direction and the filters live
 * in the URL): who did what in plain words, relative + absolute time. No total, so the pager shows Previous / Next and "Page N".
 */
export default function Audit() {
  const view = useListView(LIST);
  const [, setParams] = useSearchParams();
  const when = parseWhen(view.filters.since);
  // The start of a local day: the same number all day, so the subscription does not change every minute.
  const since = useMemo(() => sinceFor(when), [when]);
  const aboutId = view.filters.about || undefined;
  const aboutLabel = view.filters.label || s.aboutThis;

  const paging = useListPaging(view, { total: null });
  const audit = useAuditScreen({ ...paging.query, since, targetId: aboutId });

  // Two parameters change together: one update, so the second does not undo the first.
  const setAbout = useCallback(
    (id: string | null, label?: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === null) {
            next.delete("about");
            next.delete("label");
          } else {
            next.set("about", id);
            next.set("label", (label ?? "").slice(0, LABEL_MAX));
          }
          next.delete("page");
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const clearAll = useCallback(
    () =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const k of ["since", "about", "label", "page"]) next.delete(k);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const cols = useMemo<Column<AuditEntry>[]>(
    () => [
      {
        key: "at",
        header: s.colTime,
        type: "date",
        sortable: true,
        sortDefaultDir: "desc",
        card: "fact",
        cell: (e) => (
          <span className="dash-cell-stack">
            <RelativeTime ms={e.at} />
            <span className="dash-cell-sub">{formatDateTime(e.at)}</span>
          </span>
        ),
        cardCell: (e) => <RelativeTime ms={e.at} />,
      },
      { key: "action", header: s.colAction, primary: true, type: "name", maxWidth: 240, cell: (e) => <strong style={{ fontWeight: 600 }}>{actionLabel(e.action)}</strong> },
      {
        key: "actor",
        header: s.colActor,
        type: "name",
        maxWidth: 240,
        card: "fact",
        cell: (e) => {
          const kind = actorKind(e.actorType);
          return (
            <span className="dash-cell-stack">
              <span className="dash-truncate" title={e.actorLabel}>
                <ActorLabel entry={e} />
              </span>
              {kind !== e.actorLabel ? <span className="dash-cell-sub">{kind}</span> : null}
            </span>
          );
        },
        // On a card the PC's name says it is a PC; a team member is an email, and "Rulebox" needs no second word.
        cardCell: (e) => (e.actorType === "device" ? <><ActorLabel entry={e} /> · {actorKind(e.actorType)}</> : <ActorLabel entry={e} />),
      },
      {
        key: "target",
        header: s.colTarget,
        type: "name",
        maxWidth: 240,
        card: "fact",
        isEmpty: (e) => !e.targetLabel,
        cell: (e) =>
          e.targetLabel ? (
            <span className="au-target">
              <span className="au-target__name">
                <TargetLink entry={e} />
              </span>
              {/* Already looking at one item: every row is about it. */}
              {e.targetId && !aboutId ? (
                <button type="button" className="au-only" aria-label={s.onlyThis(e.targetLabel)} title={s.onlyThis(e.targetLabel)} onClick={() => setAbout(e.targetId!, e.targetLabel)}>
                  <IconFilter aria-hidden="true" />
                </button>
              ) : null}
            </span>
          ) : (
            <span className="dash-muted">—</span>
          ),
      },
      {
        key: "summary",
        header: s.colSummary,
        type: "text",
        maxWidth: 360,
        card: "detail",
        cardLabel: false,
        isEmpty: (e) => !e.summary,
        cell: (e) => plainSummary(e),
      },
    ],
    [aboutId, setAbout],
  );

  const filtered = when !== "all" || aboutId !== undefined;
  const clear = (
    <Button variant="ghost" onClick={clearAll}>
      {s.clearFilters}
    </Button>
  );

  return (
    <div className="dash-page">
      <PageHeader
        title={s.title}
        lead={
          <>
            {s.lead} {s.timesLocal} <InfoTip label={s.timeZoneInfoLabel}>{s.timeZoneInfo(timeZoneName())}</InfoTip>
          </>
        }
        actions={
          <span className="au-print">
            <Button variant="ghost" onClick={() => window.print()}>
              <IconPrinter aria-hidden="true" />
              {s.print}
            </Button>
            <InfoTip label={s.printInfoLabel}>{s.printInfo}</InfoTip>
          </span>
        }
      />
      <ServerTable<AuditEntry>
        framed
        caption={s.title}
        columns={cols}
        getKey={(e) => e._id}
        paging={paging}
        list={audit}
        total={null}
        skeletonRows={10}
        filters={
          <>
            <div className="au-when">
              <SegmentedControl<When>
                aria-label={s.whenLabel}
                options={WHEN_CHOICES.map((value) => ({ value, label: s.when[value] }))}
                value={when}
                onChange={(value) => view.setFilter("since", value === "all" ? null : value)}
              />
            </div>
            {aboutId ? (
              <span className="au-chip">
                <span className="au-chip__text" title={aboutLabel}>
                  {s.about}: <strong>{aboutLabel}</strong>
                </span>
                <button type="button" className="au-chip__x" aria-label={s.clearAbout(aboutLabel)} onClick={() => setAbout(null)}>
                  <IconClose aria-hidden="true" />
                </button>
              </span>
            ) : null}
          </>
        }
        empty={
          filtered ? (
            <EmptyState icon={<IconHistory />} title={aboutId ? s.emptyAboutTitle(aboutLabel, when !== "all") : s.emptyPeriodTitle} action={clear} />
          ) : (
            <EmptyState icon={<IconHistory />} title={s.emptyTitle} body={s.emptyBody} />
          )
        }
      />
    </div>
  );
}

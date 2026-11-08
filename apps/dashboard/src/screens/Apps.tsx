import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { Pill, SegmentedControl } from "@rulebox/ui";
import IconWidget from "~icons/solar/widget-2-linear";
import IconGlobal from "~icons/solar/global-linear";
import IconMonitor from "~icons/solar/monitor-linear";
import { useAppsCount, useAppsScreen } from "../data/apps";
import type { AppRow, InstallSummary } from "../data/types";
import { AppGlyph } from "../components/AppGlyph";
import type { Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { formatCount } from "../lib/format";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { appsStrings } from "../lib/screenStrings/apps";
import { installStateStrings } from "../lib/screenStrings/installState";

const s = appsStrings;

/** Server sort keys of `apps:list`; the first is the default (newest first). */
const LIST: ListConfig = { sorts: ["created", "name"], defaultSort: { key: "created", dir: "desc" }, filters: ["archived"] };

function Summary({ summary }: { summary: InstallSummary | null }) {
  if (!summary) return <span className="dash-muted">{s.noInstalls}</span>;
  const total = Math.max(1, summary.installed + summary.failed + summary.inProgress);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <span className="dash-cell-stack" style={{ minWidth: 160 }}>
      <span className="dash-meter" aria-hidden="true">
        <span style={{ width: pct(summary.installed), background: "var(--rb-success)" }} />
        <span style={{ width: pct(summary.failed), background: "var(--rb-danger)" }} />
        <span style={{ width: pct(summary.inProgress), background: "var(--rb-muted)" }} />
      </span>
      <span className="dash-cell-sub" style={{ whiteSpace: "normal" }}>
        {formatCount(summary.installed, 1000)} {installStateStrings.installed.toLowerCase()} · {formatCount(summary.failed, 1000)}{" "}
        {installStateStrings.failed.toLowerCase()} · {formatCount(summary.inProgress, 1000)} {installStateStrings.pending.toLowerCase()}
      </span>
    </span>
  );
}

/**
 * `apps:list`, one page at a time: sort, search (Enter), page size and page live in the URL; the archived tab is
 * the `archived` parameter. The total is `apps:count` (the active tab, no search).
 */
export default function Apps() {
  const navigate = useNavigate();
  const view = useListView(LIST);
  const archived = view.filters.archived === "1";
  const total = useAppsCount({ archived, search: view.search });
  const paging = useListPaging(view, { total });
  const apps = useAppsScreen({ archived, ...paging.query });

  const cols = useMemo<Column<AppRow>[]>(
    () => [
      {
        key: "name",
        header: s.colName,
        primary: true,
        sortable: true,
        cell: (a) => (
          <span className="dash-row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <AppGlyph name={a.name} hue={a.hue} iconUrl={a.iconUrl} />
            <span className="dash-cell-stack">
              <Link className="dash-link dash-link--plain dash-truncate" to={`/apps/${a._id}`} title={a.name}>
                {a.name}
              </Link>
              {a.description ? (
                <span className="dash-cell-sub" title={a.description}>
                  {a.description}
                </span>
              ) : null}
            </span>
          </span>
        ),
      },
      {
        key: "kind",
        header: s.colKind,
        cell: (a) => (
          <span className="dash-row" style={{ gap: 6, flexWrap: "nowrap" }}>
            {a.kind === "web" ? <IconGlobal aria-hidden="true" /> : <IconMonitor aria-hidden="true" />}
            <span>{a.kind === "web" ? s.web : s.desktop}</span>
            {a.source ? <Pill>{s.sources[a.source]}</Pill> : null}
          </span>
        ),
      },
      { key: "groups", header: s.colGroups, cell: (a) => (a.groupCount ? s.groups(a.groupCount, a.groupCountMore) : <span className="dash-muted">—</span>) },
      { key: "installs", header: s.colInstalls, isEmpty: (a) => a.kind === "web", cell: (a) => (a.kind === "web" ? <span className="dash-muted">—</span> : <Summary summary={a.summary} />) },
      {
        key: "created",
        header: s.colAdded,
        sortable: true,
        sortDefaultDir: "desc",
        isEmpty: (a) => a.createdAt === undefined,
        cell: (a) => (a.createdAt === undefined ? <span className="dash-muted">—</span> : <RelativeTime ms={a.createdAt} />),
      },
    ],
    [],
  );

  const add = (
    <RoleGate minRole="admin">
      <Link to="/apps/new?kind=web" className="rb-btn rb-btn--ghost">
        <IconGlobal aria-hidden="true" />
        {s.addWeb}
      </Link>
      <Link to="/apps/new?kind=desktop" className="rb-btn rb-btn--primary">
        <IconMonitor aria-hidden="true" />
        {s.addDesktop}
      </Link>
    </RoleGate>
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      <ServerTable<AppRow>
        framed
        caption={s.title}
        columns={cols}
        getKey={(a) => a._id}
        paging={paging}
        list={apps}
        total={typeof total === "number" ? total : null}
        search={{ label: s.searchLabel, placeholder: s.searchPlaceholder }}
        sortByRelevanceWhenSearching
        onRowClick={(a) => navigate(`/apps/${a._id}`)}
        filters={
          <SegmentedControl<"active" | "archived">
            aria-label={s.showArchived}
            options={[
              { value: "active", label: s.active },
              { value: "archived", label: s.archived },
            ]}
            value={archived ? "archived" : "active"}
            onChange={(val) => view.setFilter("archived", val === "archived" ? "1" : null)}
          />
        }
        empty={
          archived ? (
            <EmptyState icon={<IconWidget />} title={s.emptyArchivedTitle} body={s.emptyArchivedBody} />
          ) : (
            <EmptyState icon={<IconWidget />} title={s.emptyTitle} body={s.emptyBody} action={add} />
          )
        }
      />
    </div>
  );
}

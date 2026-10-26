import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { Pill, SegmentedControl } from "@rulebox/ui";
import IconWidget from "~icons/solar/widget-2-linear";
import IconGlobal from "~icons/solar/global-linear";
import IconMonitor from "~icons/solar/monitor-linear";
import { useAppsScreen } from "../data";
import type { AppRow, InstallSummary } from "../data/types";
import { AppGlyph } from "../components/AppGlyph";
import { Card } from "../components/Card";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { LoadMore } from "../components/LoadMore";
import { PageHeader } from "../components/PageHeader";
import { PagedRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { SkeletonRows } from "../components/Skeleton";
import { formatCount } from "../lib/format";
import { strings } from "../lib/strings";

const s = strings.apps;

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
        {formatCount(summary.installed, 1000)} {strings.installState.installed.toLowerCase()} · {formatCount(summary.failed, 1000)}{" "}
        {strings.installState.failed.toLowerCase()} · {formatCount(summary.inProgress, 1000)} {strings.installState.pending.toLowerCase()}
      </span>
    </span>
  );
}

/** `apps:list` (paginated), active or archived. */
export default function Apps() {
  const [params, setParams] = useSearchParams();
  const archived = params.get("archived") === "1";
  const apps = useAppsScreen({ archived });

  const cols = useMemo<Column<AppRow>[]>(
    () => [
      {
        key: "name",
        header: s.colName,
        primary: true,
        cell: (a) => (
          <span className="dash-row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <AppGlyph name={a.name} hue={a.hue} />
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
      { key: "groups", header: s.colGroups, cell: (a) => (a.groupCount ? s.groups(a.groupCount) : <span className="dash-muted">—</span>) },
      { key: "installs", header: s.colInstalls, isEmpty: (a) => a.kind === "web", cell: (a) => (a.kind === "web" ? <span className="dash-muted">—</span> : <Summary summary={a.summary} />) },
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
      <div className="dash-filters">
        <SegmentedControl<"active" | "archived">
          aria-label={s.showArchived}
          options={[
            { value: "active", label: s.active },
            { value: "archived", label: s.archived },
          ]}
          value={archived ? "archived" : "active"}
          onChange={(val) => setParams(val === "archived" ? { archived: "1" } : {}, { replace: true })}
        />
      </div>
      <Card body="none">
        <PagedRegion state={apps} skeleton={<SkeletonRows rows={6} columns={4} />}>
          {(p) =>
            p.items.length === 0 ? (
              archived ? (
                <EmptyState icon={<IconWidget />} title={s.emptyArchivedTitle} body={s.emptyArchivedBody} />
              ) : (
                <EmptyState icon={<IconWidget />} title={s.emptyTitle} body={s.emptyBody} action={add} />
              )
            ) : (
              <>
                <DataTable caption={s.title} columns={cols} rows={p.items} getKey={(a) => a._id} />
                <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
              </>
            )
          }
        </PagedRegion>
      </Card>
    </div>
  );
}

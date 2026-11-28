import { useState } from "react";
import { Pill } from "@rulebox/ui";
import { useDeviceVersions } from "../../data/devices";
import type { DevicePage, DocVersion } from "../../data/types";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { HistoryPanel } from "../../components/HistoryPanel";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { formatDateTime, formatNumber } from "../../lib/format";
import { deviceText as t } from "./strings";

/**
 * The Activity tab: what happened to this PC (the audit history, one page at a time) and, one click deeper, the versions of its
 * settings. The versions query is subscribed only while the disclosure is open.
 */
export default function ActivityTab({ d }: { d: Pick<DevicePage, "_id" | "report"> }) {
  return (
    <div className="dash-split">
      <div className="dash-split__main">
        <HistoryPanel targetId={d._id} title={t.historyTitle} />
      </div>
      <div className="dash-split__aside">
        <VersionsCard deviceId={d._id} applied={d.report?.appliedVersion} />
      </div>
    </div>
  );
}

function VersionsCard({ deviceId, applied }: { deviceId: string; applied: number | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title={t.versionsTitle} sub={t.versionsLead} className="dev-versions">
      <details className="dash-advanced" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>{t.versionsShow}</summary>
        <div className="dash-advanced__body">{open ? <Versions deviceId={deviceId} applied={applied} /> : null}</div>
      </details>
    </Card>
  );
}

function Versions({ deviceId, applied }: { deviceId: string; applied: number | undefined }) {
  const versions = useDeviceVersions(deviceId, true);
  return (
    <QueryRegion state={versions} skeleton={<SkeletonBlock lines={4} />}>
      {(rows) =>
        rows.length === 0 ? (
          <EmptyState compact title={t.versionsNone} />
        ) : (
          <DataTable caption={t.versionsTitle} columns={versionCols(applied)} rows={rows} getKey={(v) => String(v.version)} />
        )
      }
    </QueryRegion>
  );
}

function versionCols(applied: number | undefined): Column<DocVersion>[] {
  return [
    { key: "version", header: t.versionCol, primary: true, type: "mono", cell: (v) => <span className="dash-chip dash-mono">v{formatNumber(v.version)}</span> },
    { key: "reason", header: t.versionReason, type: "text", cell: (v) => v.reason },
    { key: "date", header: t.versionDate, type: "date", cell: (v) => formatDateTime(v.createdAt) },
    {
      key: "applied",
      header: t.versionApplied,
      type: "badge",
      isEmpty: (v) => applied !== v.version,
      cell: (v) => (applied === v.version ? <Pill tone="success">{t.versionAppliedNow}</Pill> : null),
    },
  ];
}

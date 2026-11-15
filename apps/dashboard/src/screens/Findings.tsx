import { useMemo, useState } from "react";
import { Button, Pill, SegmentedControl } from "@rulebox/ui";
import IconShield from "~icons/solar/shield-check-linear";
import { useFindingsPage, useIgnoreFinding } from "../data/lockdown";
import { FINDING_STATUSES, type FindingRow, type FindingStatus } from "../data/types";
import type { Column } from "../components/DataTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { ServerTable } from "../components/ServerTable";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { allowKinds } from "./lockdown/rules";
import { useCan } from "../lib/member";
import { useToast } from "../lib/toast";
import { AllowDialog } from "./lockdown/AllowDialog";
import { findingsStrings as s, lockdownErrorMessage } from "./lockdown/strings";

/** `lockdown:findings` sorts by "seen" only (last seen first); the status tab is the `status` parameter. No search, no total. */
const LIST: ListConfig = { sorts: ["seen"], defaultSort: { key: "seen", dir: "desc" }, filters: ["status"] };

/**
 * `/lockdown/findings` (plan 4.10, 4.20): the programs the rules blocked or would block, one row per program: file name, signer,
 * the kind of folder it was found in, the rule that caught it, on how many PCs, last seen. Never a full path, a command line or
 * which PCs. Admins allow (an exception) or ignore; viewers read.
 */
export default function Findings() {
  const view = useListView(LIST);
  const wanted = view.filters.status;
  const status: FindingStatus = (FINDING_STATUSES as readonly string[]).includes(wanted ?? "") ? (wanted as FindingStatus) : "new";
  const paging = useListPaging(view, { total: null });
  const page = useFindingsPage({ ...paging.query, status });
  const canAct = useCan("admin");
  const toast = useToast();
  const ignore = useIgnoreFinding();
  const [allowing, setAllowing] = useState<FindingRow | null>(null);
  const [ignoring, setIgnoring] = useState<FindingRow | null>(null);

  const cols = useMemo<Column<FindingRow>[]>(
    () => [
      {
        key: "program",
        header: s.colProgram,
        primary: true,
        cell: (f) => (
          <span className="dash-cell-stack">
            <strong className="dash-wrap" style={{ fontWeight: 600 }}>
              {f.fileName}
            </strong>
            {f.product ? <span className="dash-cell-sub dash-wrap">{f.product}</span> : null}
          </span>
        ),
      },
      {
        key: "signer",
        header: s.colSigner,
        cell: (f) => (f.signer === null ? <Pill tone="warning">{s.unsigned}</Pill> : <span className="dash-wrap">{f.signer}</span>),
      },
      { key: "where", header: s.colWhere, cell: (f) => s.folders[f.folderClass] ?? s.folders.other },
      { key: "layer", header: s.colLayer, cell: (f) => s.layers[f.layer] },
      { key: "devices", header: s.colDevices, cell: (f) => s.pcs(f.deviceCount) },
      { key: "seen", header: s.colSeen, sortable: true, sortDefaultDir: "desc", cell: (f) => <RelativeTime ms={f.lastSeenAt} /> },
      {
        key: "actions",
        header: s.colActions,
        actions: true,
        isEmpty: (f) => !canAct || f.status === "allowed",
        cell: (f) =>
          !canAct || f.status === "allowed" ? null : (
            <span className="dash-row" style={{ flexWrap: "nowrap", gap: 6 }}>
              <Button
                variant="ghost"
                className="dash-btn--sm"
                disabled={allowKinds(f).length === 0}
                title={allowKinds(f).length === 0 ? s.appControlNote : undefined}
                onClick={() => setAllowing(f)}
              >
                {s.allow}
              </Button>
              {f.status === "new" ? (
                <Button variant="ghost" className="dash-btn--sm" onClick={() => setIgnoring(f)}>
                  {s.ignore}
                </Button>
              ) : null}
            </span>
          ),
      },
    ],
    [canAct],
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} />
      <AllowDialog finding={allowing} onClose={() => setAllowing(null)} />
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
      <ServerTable<FindingRow>
        framed
        caption={s.title}
        columns={cols}
        getKey={(f) => f._id}
        paging={paging}
        list={page}
        total={null}
        skeletonRows={6}
        filters={
          <SegmentedControl<FindingStatus>
            aria-label={s.statusLabel}
            options={FINDING_STATUSES.map((value) => ({ value, label: s.statuses[value] }))}
            value={status}
            onChange={(val) => view.setFilter("status", val === "new" ? null : val)}
          />
        }
        empty={<EmptyState icon={<IconShield />} title={s.emptyTitle[status]} body={s.emptyBody[status]} />}
      />
    </div>
  );
}

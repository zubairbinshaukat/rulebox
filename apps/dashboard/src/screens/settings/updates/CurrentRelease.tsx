import { useState } from "react";
import { Button, Pill } from "@rulebox/ui";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import type { ReleaseScreen } from "../../../data/release/api";
import { Card } from "../../../components/Card";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { EmptyState } from "../../../components/EmptyState";
import { InlineNotice } from "../../../components/Notice";
import { formatBytes } from "../../../lib/format";
import { updates as s } from "../strings";
import { fileNameOf } from "./model";

/**
 * "Your PCs update to": what the PCs install now. The address, the checksum and the exact size are real values that nobody has to read,
 * so they sit in "Technical details". `changed`: a release on GitHub has the same address but another checksum (the tag was re-run).
 */
export function CurrentRelease({
  data,
  isOwner,
  changed,
  onStop,
}: {
  data: ReleaseScreen;
  isOwner: boolean;
  changed: boolean;
  /** Clears the release (`ruleboxRelease:set` with `null`, revision of the screen). */
  onStop: () => Promise<unknown>;
}) {
  const [confirm, setConfirm] = useState(false);
  const r = data.release;
  return (
    <Card
      level={3}
      title={s.currentTitle}
      className="upd__current"
      actions={
        isOwner && r !== null ? (
          <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setConfirm(true)}>
            {s.stop}
          </Button>
        ) : undefined
      }
    >
      {r === null ? (
        <EmptyState compact icon={<IconDownload />} title={s.noneTitle} body={s.noneBody} />
      ) : (
        <div className="upd-current">
          <p className="upd-current__name">
            <strong>{s.rulebox(r.version)}</strong>
            <Pill tone="accent" dot>
              {s.current}
            </Pill>
          </p>
          <p className="upd-current__meta">
            {formatBytes(r.sizeBytes)} · <span className="dash-wrap">{fileNameOf(r.url)}</span>
          </p>
          {changed ? <InlineNotice tone="warning" title={s.changedCurrent} /> : null}
          <details className="dash-advanced">
            <summary>{s.technical}</summary>
            <div className="dash-advanced__body">
              <dl className="upd-tech">
                <div>
                  <dt>{s.version}</dt>
                  <dd className="dash-mono">{r.version}</dd>
                </div>
                <div>
                  <dt>{s.size}</dt>
                  <dd>{s.sizeBytes(r.sizeBytes)}</dd>
                </div>
                <div>
                  <dt>{s.url}</dt>
                  <dd className="dash-mono dash-wrap">{r.url}</dd>
                </div>
                <div>
                  <dt>{s.sha256}</dt>
                  <dd className="dash-mono dash-wrap">{r.sha256}</dd>
                </div>
              </dl>
            </div>
          </details>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={s.stopTitle}
        body={s.stopBody}
        confirmLabel={s.stop}
        danger
        onConfirm={onStop}
        onClose={() => setConfirm(false)}
      />
    </Card>
  );
}

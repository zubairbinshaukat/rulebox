import { useState } from "react";
import { Button, Input, SegmentedControl, Select, Switch, Textarea } from "@rulebox/ui";
import { UPDATE_MODES, type AppDetail, type ApplyWhen, type FeedStatus, type UpdateMode } from "../data/types";
import { useRollbackApp } from "../data";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field, FieldSet } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { appUpdateStrings as s } from "../lib/screenStrings/appUpdates";
import { useToast } from "../lib/toast";
import type { FormApi, FormValues } from "./AppEdit";

/**
 * The "Updates" card of a Windows program (Phase 6 Step 10, plan 4.4): its version, the update mode with one line of help,
 * the fields of the chosen mode, the feed's status line (`apps:get` `feedStatus`, no extra query) and "Roll back to <version>".
 */
export default function UpdatesCard({
  d,
  f,
  mode,
  browser,
  isNew,
  readOnly,
  revision,
  onRolledBack,
}: {
  d: AppDetail;
  f: FormApi;
  /** The mode the form saves (`effectiveMode`: Chrome and Edge are always Vendor). */
  mode: UpdateMode;
  browser: boolean;
  isNew: boolean;
  readOnly: boolean;
  revision: number;
  onRolledBack: (revision: number) => void;
}) {
  const x = f.values;
  const toast = useToast();
  const rollback = useRollbackApp();
  const [confirm, setConfirm] = useState(false);
  const previous = !isNew && d.desktop?.update?.mode === "managed" ? d.desktop.previous : undefined;
  const text = (key: keyof FormValues & string, value: string) => f.set(key, value as never);
  return (
    <Card
      title={s.updates}
      sub={s.updatesSub}
      actions={
        previous ? (
          <RoleGate minRole="admin">
            <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => setConfirm(true)} disabled={readOnly}>
              {s.rollbackTo(previous.version)}
            </Button>
          </RoleGate>
        ) : undefined
      }
    >
      <div className="dash-form">
        <Field label={s.version} hint={mode === "pinned" ? s.versionPinnedHint : s.versionHint} error={f.errors.version} optional={mode === "pinned"} required={mode === "managed"}>
          {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={40} value={x.version} onChange={(e) => text("version", e.target.value)} />}
        </Field>

        {browser ? (
          <InlineNotice tone="neutral" title={s.updateModes.vendor} detail={s.browserForced} />
        ) : (
          <FieldSet legend={s.updateMode} hint={s.updateModeHelp[mode]} error={f.errors.updateMode}>
            <div style={{ overflowX: "auto", maxWidth: "100%" }}>
              <SegmentedControl<UpdateMode>
                aria-label={s.updateMode}
                options={UPDATE_MODES.map((m) => ({ value: m, label: s.updateModes[m] }))}
                value={x.updateMode}
                onChange={(m) => f.set("updateMode", m)}
              />
            </div>
          </FieldSet>
        )}
        {browser ? <p className="dash-field__hint">{s.updateModeHelp.vendor}</p> : null}

        {mode === "vendor" ? (
          <>
            <div className="dash-form__row">
              <Field label={s.publisher} hint={s.publisherHint} error={f.errors.publisher} required={!browser} optional={browser}>
                {(p) => <Input {...p} spellCheck={false} autoComplete="off" maxLength={200} value={x.publisher} onChange={(e) => text("publisher", e.target.value)} />}
              </Field>
              <Field label={s.publisherProduct} hint={s.publisherProductHint} optional>
                {(p) => <Input {...p} spellCheck={false} autoComplete="off" maxLength={100} value={x.publisherProduct} onChange={(e) => text("publisherProduct", e.target.value)} />}
              </Field>
            </div>
            {x.publisher.trim() !== "" && x.publisherProduct.trim() === "" && f.errors.publisher === undefined ? <InlineNotice tone="warning" title={s.publisherBroad} /> : null}
            <Field label={s.minVersion} hint={s.minVersionHint} error={f.errors.minVersion} optional>
              {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={40} value={x.minVersion} onChange={(e) => text("minVersion", e.target.value)} />}
            </Field>
          </>
        ) : null}

        {mode === "managed" ? (
          <>
            <Field label={s.feedUrl} hint={s.feedHint} error={f.errors.feedUrl} optional>
              {(p) => <Input {...p} type="url" inputMode="url" spellCheck={false} autoCapitalize="off" placeholder="https://" value={x.feedUrl} onChange={(e) => text("feedUrl", e.target.value)} />}
            </Field>
            {x.feedUrl.trim() !== "" ? (
              <>
                <Field label={s.feedPubkey} hint={s.feedPubkeyHint} error={f.errors.feedPubkey} required>
                  {(p) => <Textarea {...p} rows={2} className="dash-mono" spellCheck={false} autoCapitalize="off" value={x.feedPubkey} onChange={(e) => text("feedPubkey", e.target.value)} />}
                </Field>
                <Field label={s.feedTarget} hint={s.feedTargetHint} error={f.errors.feedTarget} required>
                  {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={40} value={x.feedTarget} onChange={(e) => text("feedTarget", e.target.value)} />}
                </Field>
                <Switch checked={x.autoPublish} onChange={(val) => f.set("autoPublish", val)} label={s.autoPublish} disabled={readOnly} />
                <p className="dash-field__hint">{s.autoPublishHint}</p>
              </>
            ) : null}
            <Field label={s.applyWhen} optional>
              {(p) => (
                <Select {...p} value={x.applyWhen} onChange={(e) => f.set("applyWhen", e.target.value as ApplyWhen)}>
                  {(Object.keys(s.applyWhens) as ApplyWhen[]).map((w) => (
                    <option key={w} value={w}>
                      {s.applyWhens[w]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Switch checked={x.rollbackOnFail} onChange={(val) => f.set("rollbackOnFail", val)} label={s.rollbackOnFail} disabled={readOnly} />
            {!isNew && !previous ? <p className="dash-field__hint">{s.rollbackNone}</p> : null}
          </>
        ) : null}

        {!isNew && d.feedStatus ? <FeedStatusLine status={d.feedStatus} /> : null}
      </div>

      {previous ? (
        <ConfirmDialog
          open={confirm}
          title={s.rollbackTitle(previous.version)}
          body={
            <>
              {s.rollbackBody(d.desktop?.version ?? "", previous.version)}
              {f.dirty ? <> {s.rollbackDiscards}</> : null}
            </>
          }
          confirmLabel={s.rollback}
          onConfirm={async () => onRolledBack((await rollback({ appId: d._id, expectedRevision: revision })).revision)}
          onDone={() => toast(s.rolledBack(previous.version))}
          onClose={() => setConfirm(false)}
        />
      ) : null}
    </Card>
  );
}

/** Where the vendor feed stands: a calm line when it works, a notice when it does not (7 failures in a row is a warning of its own). */
function FeedStatusLine({ status }: { status: FeedStatus }) {
  const problem = status.status === "ok" ? null : s.feedStatusProblem[status.status];
  const checked = status.lastCheckedAt !== undefined ? <RelativeTime ms={status.lastCheckedAt} /> : null;
  const detail = (
    <>
      {checked ? <>{s.feedStatusChecked} {checked}. </> : <>{s.feedStatusNever} </>}
      {status.seenVersion ? <>{s.feedStatusSeen(status.seenVersion)} </> : null}
      {status.failures > 0 ? <>{s.feedStatusFailures(status.failures)}</> : null}
    </>
  );
  if (status.pending) {
    return <InlineNotice tone="accent" title={s.feedStatusPending(status.pending.version)} detail={detail} />;
  }
  return <InlineNotice tone={problem === null ? "neutral" : status.failures >= 7 ? "danger" : "warning"} title={problem ?? s.feedStatusWorking} detail={detail} />;
}

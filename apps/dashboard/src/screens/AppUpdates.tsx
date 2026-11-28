import { useState, type ReactNode } from "react";
import { Button, InfoTip, Input, SegmentedControl, Select, Switch, Textarea } from "@rulebox/ui";
import { UPDATE_MODES, type AppDetail, type ApplyWhen, type FeedStatus, type UpdateMode } from "../data/types";
import { useApproveFeedUpdate, useCheckFeedNow, useDismissFeedUpdate, useRollbackApp, useSetFeedPaused } from "../data";
import { messageFor, toAppError } from "../lib/errors";
import { Card } from "../components/Card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field, FieldSet } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { appUpdateStrings as s } from "../lib/screenStrings/appUpdates";
import { useToast } from "../lib/toast";
import type { FormApi, FormValues } from "./apps/appForm";

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
        <Field label={s.version} info={mode === "pinned" ? s.versionPinnedHint : s.versionHint} error={f.errors.version} optional={mode === "pinned"} required={mode === "managed"}>
          {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={40} value={x.version} onChange={(e) => text("version", e.target.value)} />}
        </Field>

        {browser ? (
          <FieldSet legend={s.updateMode} info={s.updateModeHelp.vendor}>
            <InlineNotice tone="neutral" title={s.modeLabels.vendor} detail={s.browserForced} />
          </FieldSet>
        ) : (
          <FieldSet legend={s.updateMode} info={s.updateModeHelp[mode]} error={f.errors.updateMode}>
            <div style={{ overflowX: "auto", maxWidth: "100%" }}>
              <SegmentedControl<UpdateMode>
                aria-label={s.updateMode}
                options={UPDATE_MODES.map((m) => ({ value: m, label: s.modeLabels[m] }))}
                value={x.updateMode}
                onChange={(m) => f.set("updateMode", m)}
              />
            </div>
          </FieldSet>
        )}

        {mode === "vendor" ? (
          <>
            <div className="dash-form__row">
              <Field label={s.publisher} info={s.publisherHint} error={f.errors.publisher} required={!browser} optional={browser}>
                {(p) => <Input {...p} spellCheck={false} autoComplete="off" maxLength={200} value={x.publisher} onChange={(e) => text("publisher", e.target.value)} />}
              </Field>
              <Field label={s.publisherProduct} info={s.publisherProductHint} optional>
                {(p) => <Input {...p} spellCheck={false} autoComplete="off" maxLength={100} value={x.publisherProduct} onChange={(e) => text("publisherProduct", e.target.value)} />}
              </Field>
            </div>
            {x.publisher.trim() !== "" && x.publisherProduct.trim() === "" && f.errors.publisher === undefined ? <InlineNotice tone="warning" title={s.publisherBroad} /> : null}
            <Field label={s.minVersion} info={s.minVersionHint} error={f.errors.minVersion} optional>
              {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={40} value={x.minVersion} onChange={(e) => text("minVersion", e.target.value)} />}
            </Field>
          </>
        ) : null}

        {mode === "managed" ? (
          <>
            <Field label={s.feedUrl} info={s.feedHint} error={f.errors.feedUrl} optional>
              {(p) => <Input {...p} type="url" inputMode="url" spellCheck={false} autoCapitalize="off" placeholder="https://" value={x.feedUrl} onChange={(e) => text("feedUrl", e.target.value)} />}
            </Field>
            {x.feedUrl.trim() !== "" ? (
              <>
                <Field label={s.feedPubkey} info={s.feedPubkeyHint} error={f.errors.feedPubkey} required>
                  {(p) => <Textarea {...p} rows={2} className="dash-mono" spellCheck={false} autoCapitalize="off" value={x.feedPubkey} onChange={(e) => text("feedPubkey", e.target.value)} />}
                </Field>
                <Field label={s.feedTarget} info={s.feedTargetHint} error={f.errors.feedTarget} required>
                  {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={40} value={x.feedTarget} onChange={(e) => text("feedTarget", e.target.value)} />}
                </Field>
                <div className="rb-labelrow">
                  <Switch checked={x.autoPublish} onChange={(val) => f.set("autoPublish", val)} label={s.autoPublish} disabled={readOnly} />
                  <InfoTip label={`About ${s.autoPublish}`}>{s.autoPublishHint}</InfoTip>
                </div>
              </>
            ) : null}
            <Field label={s.applyWhen} optional>
              {(p) => (
                <Select
                  {...p}
                  value={x.applyWhen}
                  onChange={(w) => f.set("applyWhen", w as ApplyWhen)}
                  options={(Object.keys(s.applyWhens) as ApplyWhen[]).map((w) => ({ value: w, label: s.applyWhens[w] }))}
                />
              )}
            </Field>
            <div className="rb-labelrow">
              <Switch checked={x.rollbackOnFail} onChange={(val) => f.set("rollbackOnFail", val)} label={s.rollbackOnFail} disabled={readOnly} />
              {!isNew && !previous ? <InfoTip label={`About ${s.rollbackOnFail}`}>{s.rollbackNone}</InfoTip> : null}
            </div>
          </>
        ) : null}

        {!isNew && d.feedStatus ? <FeedStatusLine appId={d._id} status={d.feedStatus} revision={revision} dirty={f.dirty} readOnly={readOnly} onApproved={onRolledBack} /> : null}
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

/** One sentence for a refused feed action (the errors that have a plain meaning here, else the usual one). */
function feedErrorText(e: unknown): string {
  const err = toAppError(e);
  if (err?.code === "stale_edit") return s.feedStale;
  if (err?.code === "rate_limited") return s.feedCheckTooSoon;
  if (err?.code === "conflict" && err.detail === "paused") return s.feedCheckPaused;
  if (err?.code === "invalid_argument" && err.field === "pending") return s.feedNoLongerOffered;
  return messageFor(e);
}

/**
 * Where the vendor feed stands: a calm line when it works, a notice when it does not (7 failures in a row is a warning of its own).
 * Admins get Approve / Dismiss for an offered version, Check now and Pause / Resume (`feeds:*`; the status itself needs no query).
 */
function FeedStatusLine({
  appId,
  status,
  revision,
  dirty,
  readOnly,
  onApproved,
}: {
  appId: string;
  status: FeedStatus;
  revision: number;
  dirty: boolean;
  readOnly: boolean;
  /** After Approve: the revision to send next (the form starts again from the published app). */
  onApproved: (revision: number) => void;
}) {
  const toast = useToast();
  const approve = useApproveFeedUpdate();
  const dismiss = useDismissFeedUpdate();
  const checkNow = useCheckFeedNow();
  const setPaused = useSetFeedPaused();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = status.status === "paused";
  const offered = status.pending?.version;
  // One action at a time; the answer is a toast, a refusal is one sentence under the line.
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(feedErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const actions = (
    <RoleGate minRole="admin">
      <div className="dash-row" style={{ gap: 8 }}>
        {offered !== undefined ? (
          <>
            <Button
              type="button"
              className="dash-btn--sm"
              disabled={readOnly || busy || dirty}
              onClick={() =>
                run(async () => {
                  const done = await approve({ appId, expectedRevision: revision });
                  onApproved(done.revision);
                  toast(s.feedApproved(offered));
                })
              }
            >
              {s.feedApprove}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="dash-btn--sm"
              disabled={readOnly || busy}
              onClick={() =>
                run(async () => {
                  await dismiss({ appId, expectedRevision: revision });
                  toast(s.feedDismissed(offered));
                })
              }
            >
              {s.feedDismiss}
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="dash-btn--sm"
          disabled={readOnly || busy || paused}
          onClick={() =>
            run(async () => {
              const r = await checkNow({ appId });
              toast(r.result === "pending" || r.result === "published" ? s.feedChecked[r.result](r.version ?? "") : s.feedChecked[r.result]);
            })
          }
        >
          {s.feedCheckNow}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="dash-btn--sm"
          disabled={readOnly || busy}
          onClick={() =>
            run(async () => {
              await setPaused({ appId, paused: !paused });
              toast(paused ? s.feedResumed : s.feedPaused);
            })
          }
        >
          {paused ? s.feedResume : s.feedPause}
        </Button>
      </div>
    </RoleGate>
  );
  return (
    <>
      <FeedStatusNotice status={status} action={actions} hint={offered !== undefined && dirty ? s.feedApproveDirty : undefined} />
      {error ? <InlineNotice tone="danger" alert title={error} /> : null}
    </>
  );
}

function FeedStatusNotice({ status, action, hint }: { status: FeedStatus; action: ReactNode; hint?: string }) {
  const problem = status.status === "ok" ? null : s.feedStatusProblem[status.status];
  const checked = status.lastCheckedAt !== undefined ? <RelativeTime ms={status.lastCheckedAt} /> : null;
  const detail = (
    <>
      {checked ? <>{s.feedStatusChecked} {checked}. </> : <>{s.feedStatusNever} </>}
      {status.seenVersion ? <>{s.feedStatusSeen(status.seenVersion)} </> : null}
      {status.failures > 0 ? <>{s.feedStatusFailures(status.failures)} </> : null}
      {hint ?? null}
    </>
  );
  if (status.pending) {
    return <InlineNotice tone="accent" title={s.feedStatusPending(status.pending.version)} detail={detail} action={action} />;
  }
  return <InlineNotice tone={problem === null ? "neutral" : status.failures >= 7 ? "danger" : "warning"} title={problem ?? s.feedStatusWorking} detail={detail} action={action} />;
}

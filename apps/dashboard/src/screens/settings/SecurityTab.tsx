import { useState } from "react";
import { Button, Input, Pill } from "@rulebox/ui";
import IconKey from "~icons/solar/key-minimalistic-square-linear";
import {
  useClearActionPin,
  useRemovePasskey,
  useRenamePasskey,
  useResetStepUpWithRecoveryCode,
  useSetActionPin,
  useStepUpStatus,
} from "../../data/stepup";
import type { PasskeyRow, StepUpStatus } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { RelativeTime } from "../../components/RelativeTime";
import { SkeletonBlock } from "../../components/Skeleton";
import { formatDate, formatDateTime } from "../../lib/format";
import { toAppError } from "../../lib/errors";
import { stepUpMessage } from "../../lib/stepup/messages";
import { isPasskeyCancel, passkeysSupported } from "../../lib/stepup/passkey";
import { sec } from "../../lib/stepup/strings";
import { useToast } from "../../lib/toast";
import { useForm } from "../../lib/useForm";
import { useNow } from "../../lib/useNow";
import * as v from "../../lib/validate";
import { strings } from "../../lib/strings";
import { useStepUpController } from "../../stepup/context";
import { SetPinForm } from "../../stepup/SetPinForm";
import { useAddPasskey } from "../../stepup/usePasskeys";
import "../../stepup/stepup.css";

const MAX_PASSKEYS = 10;

/** Settings → Security (plan 4.16, dashboard flow 4): one query, `stepUp:status`. */
export default function SecurityTab() {
  const status = useStepUpStatus();
  return (
    <QueryRegion state={status} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
      {(st) => <Security st={st} />}
    </QueryRegion>
  );
}

type Dialog =
  | { kind: "pin" }
  | { kind: "removePin" }
  | { kind: "addPasskey" }
  | { kind: "rename"; key: PasskeyRow }
  | { kind: "removePasskey"; key: PasskeyRow };

function Security({ st }: { st: StepUpStatus }) {
  const toast = useToast();
  const controller = useStepUpController();
  const setPin = useSetActionPin();
  const clearPin = useClearActionPin();
  const removePasskey = useRemovePasskey();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const now = useNow(30_000);

  const usableKeys = st.passkeys.filter((k) => !k.suspended);
  const pinUsable = st.actionPin.set && !st.actionPin.disabled;
  const canRemovePin = usableKeys.length > 0;
  const browserPasskeys = passkeysSupported();
  const canAddPasskey = st.passkeysAvailable && browserPasskeys && st.passkeys.length < MAX_PASSKEYS;
  const local = (ms: number) => (controller ? controller.toLocal(ms) : ms);

  const pinState = !st.actionPin.set ? (
    <Pill dot>{sec.pinNotSet}</Pill>
  ) : st.actionPin.disabled ? (
    <Pill tone="danger" dot>
      {sec.pinOff}
    </Pill>
  ) : st.actionPin.lockedUntil !== null && local(st.actionPin.lockedUntil) > now ? (
    <Pill tone="warning" dot>
      {sec.pinLockedUntil(formatDateTime(local(st.actionPin.lockedUntil)))}
    </Pill>
  ) : (
    <Pill tone="success" dot>
      {sec.pinSet}
    </Pill>
  );

  return (
    <>
      <Card
        title={sec.pinCard}
        sub={sec.pinCardSub}
        actions={
          <div className="su-actions">
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "pin" })}>
              {st.actionPin.set ? sec.changePin : sec.setPinButton}
            </Button>
            {st.actionPin.set ? (
              <Button
                variant="danger-ghost"
                className="dash-btn--sm"
                disabled={!canRemovePin}
                aria-describedby={canRemovePin ? undefined : "su-pin-last"}
                onClick={() => setDialog({ kind: "removePin" })}
              >
                {sec.removePin}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="dash-form">
          <div>{pinState}</div>
          {st.actionPin.disabled ? <InlineNotice tone="warning" title={strings.errors.stepUpDisabled} /> : null}
          {st.actionPin.set && !canRemovePin ? (
            <p className="dash-muted" id="su-pin-last">
              {sec.lastFactorHint}
            </p>
          ) : null}
        </div>
      </Card>

      <Card
        title={sec.passkeysCard}
        sub={sec.passkeysCardSub(MAX_PASSKEYS)}
        body="flush"
        actions={
          canAddPasskey ? (
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "addPasskey" })}>
              <IconKey aria-hidden="true" />
              {sec.addPasskey}
            </Button>
          ) : null
        }
      >
        <div className="dash-form" style={{ padding: "12px 22px" }}>
          {!st.passkeysAvailable ? <InlineNotice tone="neutral" title={sec.passkeysOff} /> : null}
          {st.passkeysAvailable && !browserPasskeys ? <InlineNotice tone="neutral" title={sec.passkeyUnsupported} /> : null}
          {st.passkeys.length >= MAX_PASSKEYS ? <InlineNotice tone="neutral" title={sec.passkeyLimit(MAX_PASSKEYS)} /> : null}
          {st.passkeys.length === 0 ? <p className="dash-muted">{sec.passkeysEmpty}</p> : null}
        </div>
        {st.passkeys.length ? (
          <ul className="dash-list" aria-label={sec.passkeysCard}>
            {st.passkeys.map((k) => {
              const last = !pinUsable && usableKeys.filter((x) => x._id !== k._id).length === 0 && !k.suspended;
              return (
                <li key={k._id} className="dash-list__item">
                  <div className="dash-list__body">
                    <p className="dash-list__title su-passkey">
                      <span className="su-passkey__name">{k.name}</span>
                      {k.synced ? <Pill>{sec.synced}</Pill> : null}
                      {k.suspended ? (
                        <Pill tone="danger" dot>
                          {sec.suspended}
                        </Pill>
                      ) : null}
                    </p>
                    <p className="dash-list__meta">
                      {sec.created(formatDate(local(k.createdAt)))} ·{" "}
                      {k.lastUsedAt !== null ? sec.lastUsed(formatDateTime(local(k.lastUsedAt))) : sec.neverUsed}
                    </p>
                    {k.suspended ? <p className="dash-list__meta">{sec.suspendedHint}</p> : null}
                    {last ? <p className="dash-list__meta">{sec.lastPasskeyHint}</p> : null}
                  </div>
                  <div className="su-actions">
                    <Button variant="ghost" className="dash-btn--sm" aria-label={`${strings.common.rename}: ${k.name}`} onClick={() => setDialog({ kind: "rename", key: k })}>
                      {strings.common.rename}
                    </Button>
                    <Button
                      variant="danger-ghost"
                      className="dash-btn--sm"
                      disabled={last}
                      aria-label={`${sec.removePasskey}: ${k.name}`}
                      onClick={() => setDialog({ kind: "removePasskey", key: k })}
                    >
                      {sec.removePasskey}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Card>

      <Card
        title={sec.sessionCard}
        actions={
          controller && (st.actionPin.set || st.passkeys.length > 0) ? (
            <Button variant="ghost" className="dash-btn--sm" onClick={() => controller.lockNow("manual")}>
              {sec.lockNow}
            </Button>
          ) : null
        }
      >
        <p>
          {st.session.verifiedAt !== null && st.session.method !== null ? (
            <SessionLine method={st.session.method} at={local(st.session.verifiedAt)} />
          ) : (
            sec.sessionNotVerified
          )}
        </p>
        <p className="dash-muted">{sec.sessionLockHint}</p>
      </Card>

      <RecoveryCard />

      {dialog?.kind === "pin" ? (
        <Modal open title={st.actionPin.set ? sec.changePinTitle : sec.setPinTitle} onClose={() => setDialog(null)}>
          {st.actionPin.set ? <p className="dash-dialog__lead">{sec.pinChangeLead}</p> : null}
          <SetPinForm
            autoFocus
            submitLabel={sec.setPin}
            onSave={async (pin) => {
              await setPin({ pin });
              toast(sec.pinSaved);
              setDialog(null);
            }}
            extraActions={
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {strings.common.cancel}
              </Button>
            }
          />
        </Modal>
      ) : null}
      {dialog?.kind === "addPasskey" ? <AddPasskeyDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog passkey={dialog.key} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog?.kind === "removePin"}
        title={sec.removePinTitle}
        body={sec.removePinBody}
        confirmLabel={sec.removePin}
        danger
        onConfirm={() => clearPin()}
        onDone={() => toast(sec.pinRemoved)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "removePasskey"}
        title={dialog?.kind === "removePasskey" ? sec.removePasskeyTitle(dialog.key.name) : ""}
        body={sec.removePasskeyBody}
        confirmLabel={sec.removePasskey}
        danger
        onConfirm={() => (dialog?.kind === "removePasskey" ? removePasskey({ passkeyId: dialog.key._id }) : Promise.resolve())}
        onDone={() => toast(sec.passkeyRemoved)}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

function SessionLine({ method, at }: { method: "actionPin" | "passkey"; at: number }) {
  return (
    <>
      {sec.sessionVerified(method)} <RelativeTime ms={at} />.
    </>
  );
}

function AddPasskeyDialog({ onClose }: { onClose: () => void }) {
  const add = useAddPasskey();
  const toast = useToast();
  const [cancelled, setCancelled] = useState(false);
  const f = useForm({ name: sec.passkeyNameDefault as string }, (x) => ({ name: v.name(x.name, 64) ?? undefined }));
  return (
    <Modal
      open
      title={sec.addPasskeyTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          setCancelled(false);
          try {
            await add(x.name.trim());
          } catch (e) {
            if (isPasskeyCancel(e)) {
              setCancelled(true);
              return;
            }
            throw e;
          }
          toast(sec.passkeyAdded(x.name.trim()));
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" className="dash-btn--accent" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? sec.usingPasskey : strings.common.continue}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-dialog__lead">{sec.addPasskeyLead}</p>
        <Field label={sec.passkeyName} error={f.errors.name} required>
          {(p) => <Input {...p} maxLength={64} autoComplete="off" value={f.values.name} onChange={(e) => f.set("name", e.target.value)} />}
        </Field>
        {cancelled ? <InlineNotice tone="neutral" alert title={sec.passkeyCancelled} /> : null}
        {f.serverError ? <InlineNotice tone="danger" alert title={stepUpMessage(f.serverError)} /> : null}
      </div>
    </Modal>
  );
}

function RenameDialog({ passkey, onClose }: { passkey: PasskeyRow; onClose: () => void }) {
  const rename = useRenamePasskey();
  const toast = useToast();
  const f = useForm({ name: passkey.name }, (x) => ({ name: v.name(x.name, 64) ?? undefined }));
  return (
    <Modal
      open
      title={sec.renamePasskeyTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await rename({ passkeyId: passkey._id, name: x.name.trim() });
          toast(strings.common.saved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : strings.common.save}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={sec.passkeyName} error={f.errors.name} required>
          {(p) => <Input {...p} maxLength={64} autoComplete="off" value={f.values.name} onChange={(e) => f.set("name", e.target.value)} />}
        </Field>
        {f.serverError ? <InlineNotice tone="danger" alert title={stepUpMessage(f.serverError)} /> : null}
      </div>
    </Modal>
  );
}

/** Lost every factor: fresh sign-in + TOTP + one MFA recovery code (plan 4.16 table, case (b)). */
function RecoveryCard() {
  const reset = useResetStepUpWithRecoveryCode();
  const toast = useToast();
  const [reauth, setReauth] = useState(false);
  const f = useForm({ code: "" }, (x) => ({ code: v.recoveryCode(x.code) ?? undefined }));
  return (
    <Card title={sec.recoveryCard} sub={sec.recoveryLead}>
      <form
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            setReauth(false);
            try {
              await reset({ code: v.normalizeRecoveryCode(x.code) });
            } catch (err) {
              const app = toAppError(err);
              if (app?.code === "step_up_setup_required" && app.detail === "reauthenticate") setReauth(true);
              throw err;
            }
            f.reset({ code: "" });
            toast(sec.recoveryDone);
          });
        }}
      >
        <Field label={sec.recoveryCode} error={f.errors.code}>
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={12}
              value={f.values.code}
              onChange={(e) => f.set("code", e.target.value)}
              style={{ maxWidth: 240 }}
            />
          )}
        </Field>
        {f.serverError ? <InlineNotice tone={reauth ? "warning" : "danger"} alert title={stepUpMessage(f.serverError)} /> : null}
        <div>
          <Button type="submit" variant="ghost" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : sec.recoveryReset}
          </Button>
        </div>
      </form>
    </Card>
  );
}

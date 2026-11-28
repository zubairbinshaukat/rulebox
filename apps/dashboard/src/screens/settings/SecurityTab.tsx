import { useState } from "react";
import { Button, InfoTip, Input, Pill } from "@rulebox/ui";
import IconKey from "~icons/solar/key-minimalistic-square-linear";
import IconClock from "~icons/solar/clock-circle-linear";
import {
  useChangePassword,
  useGenerateRecoveryCodes,
  useRemovePasskey,
  useRenamePasskey,
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
import { AppError } from "../../lib/errors";
import { PasswordInput } from "../../components/PasswordInput";
import { useMember } from "../../lib/member";
import { stepUpMessage } from "../../lib/stepup/messages";
import { isPasskeyCancel, passkeysSupported } from "../../lib/stepup/passkey";
import { sec } from "../../lib/stepup/strings";
import { useToast } from "../../lib/toast";
import { useForm } from "../../lib/useForm";
import { useNow } from "../../lib/useNow";
import * as v from "../../lib/validate";
import { strings } from "../../lib/strings";
import { useStepUpController } from "../../stepup/context";
import { RecoveryCodes } from "../../stepup/RecoveryCodes";
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
  | { kind: "addPasskey" }
  | { kind: "password" }
  | { kind: "newCodes" }
  | { kind: "codes"; codes: string[] }
  | { kind: "rename"; key: PasskeyRow }
  | { kind: "removePasskey"; key: PasskeyRow };

function Security({ st }: { st: StepUpStatus }) {
  const toast = useToast();
  const me = useMember();
  const controller = useStepUpController();
  const setPin = useSetActionPin();
  const generateCodes = useGenerateRecoveryCodes();
  const removePasskey = useRemovePasskey();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const now = useNow(30_000);

  const browserPasskeys = passkeysSupported();
  const canAddPasskey = st.passkeysAvailable && browserPasskeys && st.passkeys.length < MAX_PASSKEYS;
  const local = (ms: number) => (controller ? controller.toLocal(ms) : ms);

  // A password change (and codes) need a fresh confirmation: ask first, then open the form.
  const confirmFresh = async (): Promise<boolean> => {
    if (!controller) return true;
    const at = st.session.verifiedAt;
    if (at !== null && controller.serverNow() - at <= st.policy.freshMs - 30_000) return true;
    return await controller.request(new AppError({ code: "step_up_required", detail: "fresh" }));
  };

  const pinState = !st.pin.set ? (
    <Pill dot>{sec.pinNotSet}</Pill>
  ) : st.pin.lockedUntil !== null && local(st.pin.lockedUntil) > now ? (
    <Pill tone="warning" dot>
      {sec.pinLockedUntil(formatDateTime(local(st.pin.lockedUntil)))}
    </Pill>
  ) : (
    <Pill tone="success" dot>
      {sec.pinSet}
    </Pill>
  );

  return (
    <div className="set-sec">
      <div className="set-strip">
        <span className="set-strip__icon" aria-hidden="true">
          <IconClock />
        </span>
        <div className="set-strip__text">
          <p className="set-strip__title">
            {sec.sessionCard}
            <InfoTip label={`About ${sec.sessionCard}`}>{sec.sessionLockHint}</InfoTip>
          </p>
          <p className="set-strip__line">
            {st.session.verifiedAt !== null && st.session.method !== null ? (
              <SessionLine method={st.session.method} at={local(st.session.verifiedAt)} />
            ) : (
              sec.sessionNotVerified
            )}
          </p>
        </div>
        {controller && st.pin.set ? (
          <Button variant="ghost" className="dash-btn--sm" onClick={() => controller.lockNow("manual")}>
            {sec.lockNow}
          </Button>
        ) : null}
      </div>

      <Card
        level={3}
        className="set-sec__pin"
        title={sec.pinCard}
        actions={
          <div className="su-actions">
            <InfoTip label={`About ${sec.pinCard}`}>{sec.pinCardSub}</InfoTip>
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "pin" })}>
              {st.pin.set ? sec.changePin : sec.setPinButton}
            </Button>
          </div>
        }
      >
        <div className="dash-form">
          <div>{pinState}</div>
          <p className="dash-muted">{sec.pinRequiredHint}</p>
        </div>
      </Card>

      <Card
        level={3}
        className="set-sec__passkeys"
        title={sec.passkeysCard}
        body="flush"
        actions={
          <div className="su-actions">
            <InfoTip label={`About ${sec.passkeysCard}`}>{sec.passkeysCardSub(MAX_PASSKEYS)}</InfoTip>
            {canAddPasskey ? (
              <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "addPasskey" })}>
                <IconKey aria-hidden="true" />
                {sec.addPasskey}
              </Button>
            ) : null}
          </div>
        }
      >
        {!st.passkeysAvailable || !browserPasskeys || st.passkeys.length === 0 || st.passkeys.length >= MAX_PASSKEYS ? (
          <div className="dash-form" style={{ padding: "12px 22px" }}>
            {!st.passkeysAvailable ? <InlineNotice tone="neutral" title={sec.passkeysOff} /> : null}
            {st.passkeysAvailable && !browserPasskeys ? <InlineNotice tone="neutral" title={sec.passkeyUnsupported} /> : null}
            {st.passkeys.length >= MAX_PASSKEYS ? <InlineNotice tone="neutral" title={sec.passkeyLimit(MAX_PASSKEYS)} /> : null}
            {st.passkeys.length === 0 ? <p className="dash-muted">{sec.passkeysEmpty}</p> : null}
          </div>
        ) : null}
        {st.passkeys.length ? (
          <ul className="dash-list" aria-label={sec.passkeysCard}>
            {st.passkeys.map((k) => {
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
                  </div>
                  <div className="su-actions">
                    <Button variant="ghost" className="dash-btn--sm" aria-label={`${strings.common.rename}: ${k.name}`} onClick={() => setDialog({ kind: "rename", key: k })}>
                      {strings.common.rename}
                    </Button>
                    <Button
                      variant="danger-ghost"
                      className="dash-btn--sm"
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
        level={3}
        className="set-sec__recovery"
        title={sec.recoveryCard}
        actions={
          <div className="su-actions">
            <InfoTip label={`About ${sec.recoveryCard}`}>{sec.recoveryCardSub}</InfoTip>
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "newCodes" })}>
              {sec.recoveryCreate}
            </Button>
          </div>
        }
      >
        <div className="dash-form">
          <div>
            {st.pin.recoveryCodesLeft > 0 ? (
              <Pill tone="success" dot>
                {sec.recoveryLeft(st.pin.recoveryCodesLeft)}
              </Pill>
            ) : (
              <Pill tone="warning" dot>
                {sec.recoveryNone}
              </Pill>
            )}
          </div>
          <p className="dash-muted">{sec.recoveryOtherWays}</p>
        </div>
      </Card>

      <Card
        level={3}
        className="set-sec__password"
        title={sec.passwordCard}
        body="none"
        actions={
          <div className="su-actions">
            <InfoTip label={`About ${sec.passwordCard}`}>{sec.passwordCardSub}</InfoTip>
            <Button
              variant="ghost"
              className="dash-btn--sm"
              onClick={() =>
                void confirmFresh().then((ok) => {
                  if (ok) setDialog({ kind: "password" });
                })
              }
            >
              {sec.passwordChange}
            </Button>
          </div>
        }
      />

      {dialog?.kind === "pin" ? (
        <Modal open title={st.pin.set ? sec.changePinTitle : sec.setPinTitle} onClose={() => setDialog(null)}>
          {st.pin.set ? <p className="dash-dialog__lead">{sec.pinChangeLead}</p> : null}
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
      {dialog?.kind === "password" ? <PasswordDialog onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog?.kind === "newCodes"}
        title={sec.recoveryCreateTitle}
        body={sec.recoveryCreateBody}
        confirmLabel={sec.recoveryCreate}
        onConfirm={async () => {
          const codes = await generateCodes();
          setDialog({ kind: "codes", codes });
        }}
        onClose={() => setDialog((d) => (d?.kind === "newCodes" ? null : d))}
      />
      {dialog?.kind === "codes" ? (
        <Modal
          open
          title={sec.recoveryCreated}
          onClose={() => setDialog(null)}
          actions={
            <Button className="dash-btn--accent" onClick={() => setDialog(null)}>
              {strings.common.done}
            </Button>
          }
        >
          <p className="dash-dialog__lead">{sec.recoveryCreatedLead}</p>
          <RecoveryCodes codes={dialog.codes} email={me.email} />
        </Modal>
      ) : null}
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
    </div>
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

/** Current password + new password twice; the confirmation (PIN or passkey) came first. */
function PasswordDialog({ onClose }: { onClose: () => void }) {
  const change = useChangePassword();
  const toast = useToast();
  const f = useForm({ current: "", next: "", repeat: "" }, (x) => ({
    current: x.current ? undefined : strings.validate.required,
    next: v.memberPassword(x.next) ?? undefined,
    repeat: v.same(x.next, x.repeat, strings.validate.passwordsDiffer) ?? undefined,
  }));
  return (
    <Modal
      open
      title={sec.passwordChange}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await change({ currentPassword: x.current, newPassword: x.next });
          toast(sec.passwordChanged);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" className="dash-btn--accent" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? sec.passwordSaving : sec.passwordChange}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={sec.passwordCurrent} error={f.errors.current} required>
          {(p) => <PasswordInput {...p} autoFocus autoComplete="current-password" value={f.values.current} onChange={(e) => f.set("current", e.target.value)} />}
        </Field>
        <Field label={sec.passwordNew} hint={sec.passwordRules} error={f.errors.next} required>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.next} onChange={(e) => f.set("next", e.target.value)} />}
        </Field>
        <Field label={sec.passwordRepeat} error={f.errors.repeat} required>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.repeat} onChange={(e) => f.set("repeat", e.target.value)} />}
        </Field>
        {f.serverError ? <InlineNotice tone="danger" alert title={stepUpMessage(f.serverError)} /> : null}
      </div>
    </Modal>
  );
}

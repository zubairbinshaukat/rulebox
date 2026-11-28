import { useState } from "react";
import { Button, Input, Pill, Textarea } from "@rulebox/ui";
import { useLockDevice, useUnlockDevice } from "../../data";
import type { DevicePage } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { RoleGate } from "../../components/RoleGate";
import { formatDateTime } from "../../lib/format";
import { useMember } from "../../lib/member";
import { LOCK_CONTACT_MAX, LOCK_MESSAGE_MAX, noticeProblem } from "../../lib/noticeRules";
import { useToast } from "../../lib/toast";
import { LockPreview } from "./Preview";
import { lockStrings as s } from "./strings";

/** What the lock form needs of a PC (the device page and the old card both have it). */
export type LockTarget = Pick<DevicePage, "_id" | "revoked" | "lock">;

/**
 * The lock card of the device page (plan 4.17): lock or unlock one PC, with the message and contact the lock view shows and a
 * preview of it. Lock and unlock are major actions: the hook opens the confirmation dialog and retries once. A viewer sees the state only.
 */
export function LockCard({ d }: { d: LockTarget }) {
  const locked = d.lock !== null;
  const orgName = useOrgName();
  return (
    <Card
      title={s.title}
      actions={locked ? <Pill tone="danger">{s.locked}</Pill> : undefined}
      sub={locked && d.lock ? s.state(formatDateTime(d.lock.lockedAt)) : undefined}
    >
      <div className="dash-form">
        {d.revoked && !locked ? <InlineNotice tone="neutral" title={s.revokedNote} /> : null}
        <RoleGate
          minRole="admin"
          fallback={d.lock ? <LockPreview orgName={orgName} message={d.lock.message} contact={d.lock.contact ?? ""} /> : null}
        >
          {/* A fresh form per lock: its fields start from the lock that is in force. */}
          {d.revoked && !locked ? null : <LockForm key={d.lock?.lockId ?? "none"} d={d} />}
        </RoleGate>
      </div>
    </Card>
  );
}

function useOrgName(): string {
  return useMember().orgName;
}

/**
 * The lock form: message, contact, a preview of what the PC shows, and Lock / Update / Unlock. `onDone` runs after a lock or an update
 * went through (the dialog closes); `onUnlock` hands the Unlock button to the caller (a dialog cannot open another one) instead of
 * confirming here.
 */
export function LockForm({ d, onDone, onUnlock }: { d: LockTarget; onDone?: () => void; onUnlock?: () => void }) {
  const lock = useLockDevice();
  const unlock = useUnlockDevice();
  const toast = useToast();
  const orgName = useOrgName();
  const [message, setMessage] = useState(d.lock?.message ?? "");
  const [contact, setContact] = useState(d.lock?.contact ?? "");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [unlocking, setUnlocking] = useState(false);
  const messageProblem = noticeProblem(message, LOCK_MESSAGE_MAX, { multiline: true });
  const contactProblem = noticeProblem(contact, LOCK_CONTACT_MAX, { multiline: false, optional: true });
  const changed = d.lock === null || message.trim() !== d.lock.message || contact.trim() !== (d.lock.contact ?? "");

  return (
    <form
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (messageProblem || contactProblem || pending || !changed) return;
        setPending(true);
        setError(null);
        lock({ deviceId: d._id, message: message.trim(), ...(contact.trim() ? { contact: contact.trim() } : {}) }).then(
          () => {
            setPending(false);
            toast(s.locked_ok);
            onDone?.();
          },
          (err) => {
            setPending(false);
            setError(err);
          },
        );
      }}
    >
      <Field label={s.message} hint={s.messageHint} error={touched && messageProblem ? s.messageProblems[messageProblem] : null} required>
        {(p) => <Textarea {...p} rows={3} value={message} placeholder={s.messageDefault} onChange={(e) => setMessage(e.target.value)} />}
      </Field>
      <Field label={s.contact} hint={s.contactHint} error={touched && contactProblem ? s.contactProblems[contactProblem] : null} optional>
        {(p) => <Input {...p} value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" />}
      </Field>
      <LockPreview orgName={orgName} message={message} contact={contact} />
      <FormError error={error} />
      <div className="dash-form__actions">
        <Button type="submit" variant={d.lock ? "ghost" : "primary"} disabled={pending || !changed} aria-busy={pending}>
          {pending ? s.locking : d.lock ? s.update : s.lock}
        </Button>
        {d.lock ? (
          <Button variant="primary" onClick={() => (onUnlock ? onUnlock() : setUnlocking(true))} disabled={pending}>
            {s.unlock}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={unlocking}
        title={s.unlockTitle}
        body={s.unlockBody}
        confirmLabel={s.unlock}
        onConfirm={() => unlock({ deviceId: d._id })}
        onDone={() => {
          toast(s.unlocked_ok);
          onDone?.();
        }}
        onClose={() => setUnlocking(false)}
      />
    </form>
  );
}
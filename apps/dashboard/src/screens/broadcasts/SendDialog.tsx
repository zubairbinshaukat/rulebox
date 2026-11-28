import { useState } from "react";
import { Button, Checkbox, Input, NativeSelect, Textarea } from "@rulebox/ui";
import { useGroupsScreen, useSendBroadcast } from "../../data";
import type { BroadcastStyle } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { toAppError } from "../../lib/errors";
import { BROADCAST_BODY_MAX, BROADCAST_TITLE_MAX, EXPIRY_CHOICES, expiryFor, noticeProblem } from "../../lib/noticeRules";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { BroadcastPreview } from "./Preview";
import { broadcastStrings as s } from "./strings";

/** What a send is aimed at: a group the person picks, or one PC (the device page). */
export type SendTarget = { kind: "group" } | { kind: "device"; id: string; name: string };

/** The sentence for the refusals of `broadcasts:send` that need their own words. */
function describe(error: unknown): string | null {
  const e = toAppError(error);
  if (e?.code === "too_large" && e.detail === "active") return s.tooManyActive;
  if (e?.code === "conflict" && e.detail === "device revoked") return s.deviceRevoked;
  return null;
}

export function SendBroadcastDialog({ open, target, onClose }: { open: boolean; target: SendTarget; onClose: () => void }) {
  if (!open) return null;
  return <SendInner target={target} onClose={onClose} />;
}

function SendInner({ target, onClose }: { target: SendTarget; onClose: () => void }) {
  const send = useSendBroadcast();
  const toast = useToast();
  const groups = useGroupsScreen();
  const [groupId, setGroupId] = useState("");
  const [style, setStyle] = useState<BroadcastStyle>("banner");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [expiry, setExpiry] = useState("24h");
  const [ackRequired, setAckRequired] = useState(false);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const titleProblem = noticeProblem(title, BROADCAST_TITLE_MAX, { multiline: false });
  const bodyProblem = noticeProblem(body, BROADCAST_BODY_MAX, { multiline: true });
  const targetId = target.kind === "device" ? target.id : groupId;
  const targetMissing = targetId === "";
  const groupRows = groups.status === "ready" ? groups.data : [];

  function submit() {
    setTouched(true);
    if (titleProblem || bodyProblem || targetMissing || pending) return;
    setPending(true);
    setError(null);
    send({
      target: { kind: target.kind, id: targetId },
      style,
      title: title.trim(),
      body: body.trim(),
      expiresAt: expiryFor(expiry, Date.now()),
      ackRequired,
    }).then(
      (done) => {
        toast(s.sent(done.targetCount));
        onClose();
      },
      (e) => {
        setPending(false);
        setError(e);
      },
    );
  }

  return (
    <Modal
      open
      wide
      title={s.dialogTitle}
      onClose={() => !pending && onClose()}
      onSubmit={submit}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? s.sending : s.submit}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        {target.kind === "device" ? (
          <p className="dash-muted">{s.toDevice(target.name)}</p>
        ) : (
          <Field label={s.toGroup} error={touched && targetMissing ? s.targetProblem : null} required>
            {(p) => (
              <NativeSelect {...p} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">{groupRows.length === 0 && groups.status === "ready" ? s.noGroups : s.pickGroup}</option>
                {groupRows.map((g) => (
                  <option key={g._id} value={g._id}>
                    {g.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Field label={s.style} hint={s.styleHelp[style]}>
          {(p) => (
            <NativeSelect {...p} value={style} onChange={(e) => setStyle(e.target.value as BroadcastStyle)}>
              <option value="banner">{s.styles.banner}</option>
              <option value="fullscreen">{s.styles.fullscreen}</option>
            </NativeSelect>
          )}
        </Field>
        <Field label={s.messageTitle} error={touched && titleProblem ? s.titleProblems[titleProblem] : null} hint={s.titleCount([...title.trim()].length)} required>
          {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={s.body} error={touched && bodyProblem ? s.bodyProblems[bodyProblem] : null} hint={s.bodyCount([...body.trim()].length)} required>
          {(p) => <Textarea {...p} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        <Field label={s.expiry}>
          {(p) => (
            <NativeSelect {...p} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.key} value={c.key}>
                  {s.expiryChoices[c.key]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Checkbox label={s.ackRequired} hint={s.ackHint} checked={ackRequired} onChange={(e) => setAckRequired(e.target.checked)} />
        <BroadcastPreview style={style} title={title} body={body} ackRequired={ackRequired} />
        <FormError error={error} describe={describe} />
      </div>
    </Modal>
  );
}

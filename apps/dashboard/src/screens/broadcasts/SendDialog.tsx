import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Button, Checkbox, InfoTip, Input, SearchSelect, SegmentedControl, Textarea, type SelectOption } from "@rulebox/ui";
import IconPc from "~icons/solar/monitor-linear";
import { useGroupsScreen, useSendBroadcast } from "../../data";
import type { BroadcastStyle } from "../../data/types";
import { ChoiceCards } from "../../components/ChoiceCards";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { toAppError } from "../../lib/errors";
import { BROADCAST_BODY_MAX, BROADCAST_TITLE_MAX, EXPIRY_CHOICES, expiryFor, noticeProblem } from "../../lib/noticeRules";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { BroadcastPreview, StyleArt } from "./Preview";
import { broadcastStrings as s } from "./strings";
import "./broadcasts.css";

/**
 * What a send is aimed at. A group: the dialog shows a group picker, with `id` (and its `name`, used until the groups have loaded or
 * when the picker does not list it) already chosen when the dialog opens from a group's page. One PC (the device page): "To: Desk 1",
 * nothing to choose. The server targets one group or one PC; there is no "everyone".
 */
export type SendTarget = { kind: "group"; id?: string; name?: string } | { kind: "device"; id: string; name: string };

/** The sentence for the refusals of `broadcasts:send` that need their own words. */
function describe(error: unknown): string | null {
  const e = toAppError(error);
  if (e?.code === "too_large" && e.detail === "active") return s.tooManyActive;
  if (e?.code === "conflict" && e.detail === "device revoked") return s.deviceRevoked;
  return null;
}

/** A counter appears only when the text is within 20% of its limit (or over it). */
const nearLimit = (n: number, max: number) => n >= Math.ceil(max * 0.8);

const STYLE_OPTIONS = (["banner", "fullscreen"] as const).map((value) => ({
  value,
  label: s.styleOptions[value].label,
  hint: s.styleOptions[value].hint,
  art: <StyleArt style={value} />,
}));

const SHOW_FOR = EXPIRY_CHOICES.map((c) => ({ value: c.key, label: s.expiryChoices[c.key] ?? c.key }));

export function SendBroadcastDialog({ open, target, onClose }: { open: boolean; target: SendTarget; onClose: () => void }) {
  if (!open) return null;
  return <SendInner target={target} onClose={onClose} />;
}

function SendInner({ target, onClose }: { target: SendTarget; onClose: () => void }) {
  const send = useSendBroadcast();
  const toast = useToast();
  const groups = useGroupsScreen();
  const [groupId, setGroupId] = useState(target.kind === "group" ? (target.id ?? "") : "");
  const [style, setStyle] = useState<BroadcastStyle>("banner");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [expiry, setExpiry] = useState("24h");
  const [ackRequired, setAckRequired] = useState(false);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const titleLen = [...title.trim()].length;
  const bodyLen = [...body.trim()].length;
  const titleProblem = noticeProblem(title, BROADCAST_TITLE_MAX, { multiline: false });
  const bodyProblem = noticeProblem(body, BROADCAST_BODY_MAX, { multiline: true });

  const groupRows = useMemo(() => (groups.status === "ready" ? groups.data : []), [groups]);
  const groupOptions = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = groupRows.map((g) => ({ value: g._id, label: g.name }));
    // The group the dialog was opened from stays choosable while the list loads, or if it is not in it.
    if (target.kind === "group" && target.id && target.name && !out.some((o) => o.value === target.id)) out.unshift({ value: target.id, label: target.name });
    return out;
  }, [groupRows, target]);
  // An organization with one group needs no choice: it is picked for them (they can still change it, there is only one to change to).
  const onlyGroup = groups.status === "ready" && groupRows.length === 1 ? groupRows[0]!._id : "";
  const chosenGroup = target.kind === "device" ? "" : groupId || onlyGroup;
  const targetId = target.kind === "device" ? target.id : chosenGroup;
  const targetMissing = targetId === "";
  const targetName = target.kind === "device" ? target.name : (groupOptions.find((o) => o.value === chosenGroup)?.label ?? "");
  const noGroups = target.kind === "group" && groups.status === "ready" && groupRows.length === 0 && !target.id;

  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);

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
      className="bc-dialog"
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
      <div className="bc-compose">
        <div className="bc-compose__grid">
        <div className="bc-compose__form">
          {target.kind === "device" ? (
            <div className="bc-to">
              <span className="bc-to__label">{s.to}</span>
              <span className="bc-to__who">
                <IconPc aria-hidden="true" />
                <span className="bc-to__name" title={target.name}>
                  {target.name}
                </span>
              </span>
            </div>
          ) : (
            <Field label={s.to} error={touched && targetMissing ? s.targetProblem : null} required>
              {(p) => (
                <>
                  <SearchSelect
                    {...p}
                    value={chosenGroup}
                    onChange={setGroupId}
                    options={groupOptions}
                    placeholder={s.pickGroup}
                    searchPlaceholder={s.searchGroup}
                    emptyText={s.noGroupMatch}
                  />
                  {noGroups ? (
                    <p className="bc-nogroups">
                      {s.noGroups}{" "}
                      <Link className="dash-link" to="/groups">
                        {s.createGroup}
                      </Link>
                    </p>
                  ) : null}
                </>
              )}
            </Field>
          )}

          <FieldSet legend={s.style}>
            <ChoiceCards name="style" aria-label={s.style} value={style} onChange={setStyle} options={STYLE_OPTIONS} columns={2} />
          </FieldSet>

          <Field
            label={s.messageTitle}
            error={touched && titleProblem ? s.titleProblems[titleProblem] : null}
            hint={nearLimit(titleLen, BROADCAST_TITLE_MAX) ? <span className="bc-count" data-over={titleLen > BROADCAST_TITLE_MAX || undefined}>{s.titleCount(titleLen)}</span> : undefined}
            required
          >
            {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
          </Field>
          <Field
            label={s.body}
            error={touched && bodyProblem ? s.bodyProblems[bodyProblem] : null}
            hint={nearLimit(bodyLen, BROADCAST_BODY_MAX) ? <span className="bc-count" data-over={bodyLen > BROADCAST_BODY_MAX || undefined}>{s.bodyCount(bodyLen)}</span> : undefined}
            required
          >
            {(p) => <Textarea {...p} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />}
          </Field>

          <FieldSet legend={s.expiry}>
            <div className="bc-seg">
              <SegmentedControl aria-label={s.expiry} options={SHOW_FOR} value={expiry} onChange={setExpiry} />
            </div>
          </FieldSet>

          <div className="bc-ack">
            <Checkbox label={s.ackRequired} checked={ackRequired} onChange={(e) => setAckRequired(e.target.checked)} />
            <InfoTip label={s.ackInfoLabel}>{s.ackInfo}</InfoTip>
          </div>

          <div ref={errorRef}>
            <FormError error={error} describe={describe} />
          </div>
        </div>

        <div className="bc-compose__side">
          <BroadcastPreview style={style} title={title} body={body} ackRequired={ackRequired} />
          <p className="bc-recap">{targetName ? s.recap(targetName, s.recapFor[expiry] ?? "") : s.recapNobody}</p>
        </div>
        </div>
      </div>
    </Modal>
  );
}

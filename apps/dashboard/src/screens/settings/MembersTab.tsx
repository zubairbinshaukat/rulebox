import { useCallback, useMemo, useState } from "react";
import { Button, Input, Pill, Select } from "@rulebox/ui";
import IconUserPlus from "~icons/solar/user-plus-rounded-linear";
import {
  useChangeRole,
  useCreateResetCode,
  useInviteMember,
  useMembersScreen,
  useResetMemberMfa,
  useRevokeInvite,
  useSetMemberDisabled,
} from "../../data";
import type { InviteRow, MemberRow, MembersScreen, Role } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CopyField } from "../../components/CopyField";
import { DataTable, type Column } from "../../components/DataTable";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { RoleGate } from "../../components/RoleGate";
import { useCan } from "../../lib/member";
import { SkeletonRows } from "../../components/Skeleton";
import { StatusDot } from "../../components/StatusDot";
import { useToast } from "../../lib/toast";
import { formatDateTime } from "../../lib/format";
import { messageFor, toAppError } from "../../lib/errors";
import { secShell as sec } from "../../lib/stepup/strings-shell";
import { useResetMemberStepUp } from "../../data/stepup";
import { needsStepUp } from "../../stepup/context";
import { strings } from "../../lib/strings";
import { useForm } from "../../lib/useForm";
import { useNow } from "../../lib/useNow";
import * as v from "../../lib/validate";

const s = strings.settings.members;
const ROLES: Role[] = ["owner", "admin", "viewer"];

/** `members:list`; every change is Owner only (Section 4.6). */
export function MembersTab() {
  const members = useMembersScreen();
  return (
    <QueryRegion state={members} skeleton={<div className="dash-card"><SkeletonRows rows={4} columns={3} /></div>}>
      {(m) => <Members m={m} />}
    </QueryRegion>
  );
}

type Dialog =
  | { kind: "invite" }
  | { kind: "role"; member: MemberRow }
  | { kind: "disable"; member: MemberRow }
  | { kind: "resetMfa"; member: MemberRow }
  | { kind: "resetStepUp"; member: MemberRow }
  | { kind: "code"; title: string; body: string; code: string }
  | { kind: "revokeInvite"; invite: InviteRow };

function Members({ m }: { m: MembersScreen }) {
  const isOwner = useCan("owner");
  const toast = useToast();
  // Every change here is a major action (plan 4.16): the data seam opens the
  // confirm dialog when the last confirmation is stale, then retries once.
  const setDisabled = useSetMemberDisabled();
  const resetMfa = useResetMemberMfa();
  const resetCode = useCreateResetCode();
  const revokeInvite = useRevokeInvite();
  const resetStepUp = useResetMemberStepUp();
  const fail = useCallback(
    (e: unknown) => {
      // Cancelled in the confirm dialog: nothing to report.
      if (!needsStepUp(e)) toast(messageFor(e), "danger");
    },
    [toast],
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const now = useNow(30_000);
  // `members:list` returns the latest invites in every state; only open ones are pending.
  const pending = m.invites.filter((i) => i.usedAt === undefined && i.expiresAt > now);
  // The row as it is now (the dialog keeps the revision it was opened with).
  const liveRow = (row: MemberRow) => m.members.find((x) => x._id === row._id) ?? row;

  const cols = useMemo<Column<MemberRow>[]>(
    () => [
      {
        key: "email",
        header: s.colMember,
        primary: true,
        cell: (x) => (
          <span className="dash-row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <span className="dash-truncate" title={x.email} style={{ fontWeight: 600, maxWidth: 320 }}>
              {x.email}
            </span>
            {x.isYou ? <Pill tone="accent">{s.you}</Pill> : null}
          </span>
        ),
      },
      { key: "role", header: s.colRole, cell: (x) => strings.app.roles[x.role] },
      {
        key: "status",
        header: s.colStatus,
        cell: (x) => (x.status === "active" ? <StatusDot tone="success" label={s.active} /> : <StatusDot tone="neutral" label={s.disabled} />),
      },
      { key: "mfa", header: s.colMfa, cell: (x) => (x.mfaEnrolled ? <Pill tone="success" dot>{s.mfaOn}</Pill> : <Pill dot>{s.mfaOff}</Pill>) },
      ...(isOwner
        ? [
            {
              key: "act",
              header: strings.common.actions,
              actions: true,
              isEmpty: (x: MemberRow) => x.isYou,
              cell: (x: MemberRow) =>
                x.isYou ? null : (
                  <span className="dash-row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "role", member: x })} aria-label={`${s.changeRole}: ${x.email}`}>
                      {s.changeRole}
                    </Button>
                    <Button
                      variant="ghost"
                      className="dash-btn--sm"
                      aria-label={`${s.resetCode}: ${x.email}`}
                      onClick={() =>
                        resetCode({ memberId: x._id }).then(
                          (r) => setDialog({ kind: "code", title: s.resetCodeTitle, body: s.resetCodeBody(x.email), code: r.code }),
                          fail,
                        )
                      }
                    >
                      {s.resetCode}
                    </Button>
                    {x.mfaEnrolled ? (
                      <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "resetMfa", member: x })} aria-label={`${s.resetMfa}: ${x.email}`}>
                        {s.resetMfa}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      className="dash-btn--sm"
                      onClick={() => setDialog({ kind: "resetStepUp", member: x })}
                      aria-label={`${sec.resetMember}: ${x.email}`}
                    >
                      {sec.resetMember}
                    </Button>
                    {x.status === "active" ? (
                      <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "disable", member: x })} aria-label={`${s.disable}: ${x.email}`}>
                        {s.disable}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        className="dash-btn--sm"
                        aria-label={`${s.enable}: ${x.email}`}
                        onClick={() =>
                          setDisabled({ memberId: x._id, disabled: false, expectedRevision: x.revision }).then(
                            () => toast(s.saved),
                            fail,
                          )
                        }
                      >
                        {s.enable}
                      </Button>
                    )}
                  </span>
                ),
            },
          ]
        : []),
    ],
    [isOwner, resetCode, setDisabled, fail, toast],
  );

  return (
    <>
      <Card
        title={strings.settings.tabs.members}
        sub={s.lead}
        body="none"
        actions={
          <RoleGate minRole="owner">
            <Button variant="ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "invite" })}>
              <IconUserPlus aria-hidden="true" />
              {s.invite}
            </Button>
          </RoleGate>
        }
      >
        <div style={{ paddingTop: 12 }}>
          {!isOwner ? (
            <div style={{ padding: "0 22px 12px" }}>
              <InlineNotice tone="neutral" title={strings.app.ownerOnly} />
            </div>
          ) : null}
          <DataTable caption={strings.settings.tabs.members} columns={cols} rows={m.members} getKey={(x) => x._id} isDim={(x) => x.status === "disabled"} />
        </div>
      </Card>

      {pending.length ? (
        <Card title={s.pendingInvites} body="flush">
          <ul className="dash-list">
            {pending.map((i) => (
              <li key={i._id} className="dash-list__item">
                <div className="dash-list__body">
                  <p className="dash-list__title dash-truncate" title={i.email}>
                    {i.email}
                  </p>
                  <p className="dash-list__meta">
                    {i.kind === "join" ? strings.app.roles[i.role] : s.resetCodeTitle} · {s.expires(formatDateTime(i.expiresAt))}
                  </p>
                </div>
                <RoleGate minRole="owner">
                  <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setDialog({ kind: "revokeInvite", invite: i })}>
                    {strings.common.revoke}
                  </Button>
                </RoleGate>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {dialog?.kind === "invite" ? (
        <InviteDialog
          onClose={() => setDialog(null)}
          onCode={(email, code) => setDialog({ kind: "code", title: s.inviteCodeTitle, body: s.inviteCodeBody(email), code })}
        />
      ) : null}
      {dialog?.kind === "role" ? <RoleDialog opened={dialog.member} live={liveRow(dialog.member)} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "code" ? (
        <Modal open title={dialog.title} onClose={() => setDialog(null)} actions={<Button onClick={() => setDialog(null)}>{strings.common.done}</Button>}>
          <div className="dash-form">
            <InlineNotice tone="warning" title={dialog.body} />
            <CopyField value={dialog.code} label={dialog.title} />
          </div>
        </Modal>
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === "disable"}
        title={dialog?.kind === "disable" ? s.disableTitle(dialog.member.email) : ""}
        body={s.disableBody}
        confirmLabel={s.disable}
        danger
        typeToConfirm={dialog?.kind === "disable" ? dialog.member.email : undefined}
        onConfirm={() =>
          dialog?.kind === "disable"
            ? setDisabled({ memberId: dialog.member._id, disabled: true, expectedRevision: dialog.member.revision })
            : Promise.resolve()
        }
        onDone={() => toast(s.saved)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "resetMfa"}
        title={dialog?.kind === "resetMfa" ? s.resetMfaTitle(dialog.member.email) : ""}
        body={s.resetMfaBody}
        confirmLabel={s.resetMfa}
        danger
        onConfirm={() => (dialog?.kind === "resetMfa" ? resetMfa({ memberId: dialog.member._id }) : Promise.resolve())}
        onDone={() => toast(s.saved)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "resetStepUp"}
        title={dialog?.kind === "resetStepUp" ? sec.resetMemberTitle(dialog.member.email) : ""}
        body={sec.resetMemberBody}
        confirmLabel={sec.resetMember}
        danger
        typeToConfirm={dialog?.kind === "resetStepUp" ? dialog.member.email : undefined}
        onConfirm={async () => {
          if (dialog?.kind !== "resetStepUp") return;
          try {
            await resetStepUp({ memberId: dialog.member._id });
          } catch (e) {
            // The generic "no permission" sentence in the dialog; the reason as a toast.
            if (toAppError(e)?.detail === "member of another organization") toast(sec.resetMemberOtherOrg, "danger");
            throw e;
          }
        }}
        onDone={() => toast(sec.resetMemberDone)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "revokeInvite"}
        title={s.revokeInvite}
        body={dialog?.kind === "revokeInvite" ? dialog.invite.email : undefined}
        confirmLabel={strings.common.revoke}
        danger
        onConfirm={() => (dialog?.kind === "revokeInvite" ? revokeInvite({ inviteId: dialog.invite._id }) : Promise.resolve())}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

function InviteDialog({ onClose, onCode }: { onClose: () => void; onCode: (email: string, code: string) => void }) {
  const invite = useInviteMember();
  const f = useForm({ email: "", role: "admin" as Role }, (x) => ({ email: v.email(x.email) ?? undefined }));
  return (
    <Modal
      open
      title={s.inviteTitle}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          const r = await invite({ email: x.email.trim(), role: x.role });
          onCode(x.email.trim().toLowerCase(), r.code);
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : s.invite}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={s.email} error={f.errors.email} required>
          {(p) => <Input {...p} type="email" inputMode="email" autoComplete="off" autoCapitalize="off" spellCheck={false} value={f.values.email} onChange={(e) => f.set("email", e.target.value)} />}
        </Field>
        <Field label={s.role} hint={s.roleHelp[f.values.role]}>
          {(p) => (
            <Select {...p} value={f.values.role} onChange={(e) => f.set("role", e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {strings.app.roles[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FormError error={f.serverError} />
      </div>
    </Modal>
  );
}

/**
 * Change a member's role. Sends the revision the dialog was opened with; when
 * someone else changed the member meanwhile the server answers `stale_edit`
 * and Reload takes the current row (role and revision), keeping nothing.
 */
function RoleDialog({ opened, live, onClose }: { opened: MemberRow; live: MemberRow; onClose: () => void }) {
  const change = useChangeRole();
  const toast = useToast();
  const [member, setMember] = useState(opened);
  const f = useForm({ role: member.role }, () => ({}));
  return (
    <Modal
      open
      title={s.changeRoleTitle(member.email)}
      onClose={() => !f.pending && onClose()}
      onSubmit={() =>
        void f.submit(async (x) => {
          await change({ memberId: member._id, role: x.role, expectedRevision: member.revision });
          toast(s.saved);
          onClose();
        })
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={f.pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={f.pending || f.values.role === member.role} aria-busy={f.pending}>
            {f.pending ? strings.common.saving : strings.common.save}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={s.role} hint={s.roleHelp[f.values.role]}>
          {(p) => (
            <Select {...p} value={f.values.role} onChange={(e) => f.set("role", e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {strings.app.roles[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FormError
          error={f.serverError}
          onReload={() => {
            setMember(live);
            f.reset({ role: live.role });
          }}
        />
      </div>
    </Modal>
  );
}

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, Input, Pill, Select, type SelectOption } from "@rulebox/ui";
import IconUserPlus from "~icons/solar/user-plus-rounded-linear";
import {
  useChangeRole,
  useCreateResetCode,
  useInviteMember,
  useRevokeInvite,
  useSetMemberDisabled,
} from "../../data";
import { useInvitesPage, useMembersPage } from "../../data/members";
import { useAdoptedTotal } from "../../data/serverList";
import type { InviteRow, MemberRow, Role } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CopyField } from "../../components/CopyField";
import type { Column, RowAction } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { RelativeTime } from "../../components/RelativeTime";
import { RoleGate } from "../../components/RoleGate";
import { ServerTable } from "../../components/ServerTable";
import { useCan } from "../../lib/member";
import { StatusDot } from "../../components/StatusDot";
import { TruncateLazy as Truncate } from "../../components/TruncateLazy";
import { useToast } from "../../lib/toast";
import { messageFor, toAppError } from "../../lib/errors";
import { useListPaging, useListView, type ListConfig } from "../../lib/listView";
import { secShell as sec } from "../../lib/stepup/strings-shell";
import { useResetMemberStepUp } from "../../data/stepup";
import { needsStepUp } from "../../stepup/context";
import { strings } from "../../lib/strings";
import { settingsStrings } from "../../lib/screenStrings/settings";
import { useForm } from "../../lib/useForm";
import { useMinute } from "../../lib/useNow";
import * as v from "../../lib/validate";

const s = settingsStrings.members;
const ROLES: Role[] = ["owner", "admin", "viewer"];
/** The role picker: the word, and under it what the role may do. */
const ROLE_OPTIONS: SelectOption[] = ROLES.map((r) => ({ value: r, label: strings.app.roles[r], hint: s.roleHelp[r] }));

/** `members:page` sort keys (the first is the default, A to Z). Small bounded table: offset cursors, exact total inside the page. */
const MEMBERS_LIST: ListConfig = { sorts: ["email", "role", "status", "created"], defaultSort: { key: "email", dir: "asc" } };
/** `members:invitesPage`, the second list on the page: its parameters carry the prefix `i` (`ipage`, `isort`, `iq`...). */
const INVITES_LIST: ListConfig = { sorts: ["created", "email", "expires"], defaultSort: { key: "created", dir: "desc" }, prefix: "i" };

/** From this width of the section the pending invites sit beside the members (as cards); narrower, under them. */
const ASIDE_MIN = 1100;
/** The invites' search box only appears once a page cannot show them all (or while a search is applied). */
const INVITES_SEARCH_MIN = 10;

type Dialog =
  | { kind: "invite" }
  | { kind: "role"; member: MemberRow }
  | { kind: "disable"; member: MemberRow }
  | { kind: "resetStepUp"; member: MemberRow }
  | { kind: "code"; title: string; body: string; code: string }
  | { kind: "revokeInvite"; invite: InviteRow };

/** True while `ref`'s box is at least `min` px wide (no ResizeObserver, as in tests: never). */
function useBoxAtLeast(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWide((entries[0]?.contentRect.width ?? 0) >= min));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min]);
  return wide;
}

/**
 * Settings > Members: `members:page` + `members:invitesPage`; every change is Owner only (Section 4.6). The members are the main list;
 * the pending invites sit beside it from laptop width (as small cards), under it below. The section's heading is Settings' own.
 */
export function MembersTab() {
  const isOwner = useCan("owner");
  const view = useListView(MEMBERS_LIST);
  const [total, adoptTotal] = useAdoptedTotal();
  const paging = useListPaging(view, { total, offset: true });
  const members = useMembersPage(paging.query);
  adoptTotal(members);
  const toast = useToast();
  // Every change here is a major action (plan 4.16): the data seam opens the
  // confirm dialog when the last confirmation is stale, then retries once.
  const setDisabled = useSetMemberDisabled();
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
  const askRevoke = useCallback((invite: InviteRow) => setDialog({ kind: "revokeInvite", invite }), []);
  const box = useRef<HTMLDivElement>(null);
  const aside = useBoxAtLeast(box, ASIDE_MIN);
  // The row as it is now (the dialog keeps the revision it was opened with).
  const liveRow = (row: MemberRow) => (members.status === "ready" ? members.items.find((x) => x._id === row._id) : undefined) ?? row;

  const cols = useMemo<Column<MemberRow>[]>(() => {
    // Change role is the one a person comes for; the rest are one tap deeper, the risky ones last.
    const actionsOf = (x: MemberRow): RowAction[] => {
      if (!isOwner || x.isYou) return [];
      return [
        { label: s.changeRole, primary: true, onSelect: () => setDialog({ kind: "role", member: x }) },
        {
          label: s.resetCode,
          onSelect: () =>
            void resetCode({ memberId: x._id }).then(
              (r) => setDialog({ kind: "code", title: s.resetCodeTitle, body: s.resetCodeBody(x.email), code: r.code }),
              fail,
            ),
        },
        { label: sec.resetMember, danger: true, onSelect: () => setDialog({ kind: "resetStepUp", member: x }) },
        x.status === "active"
          ? { label: s.disable, danger: true, onSelect: () => setDialog({ kind: "disable", member: x }) }
          : {
              label: s.enable,
              onSelect: () => void setDisabled({ memberId: x._id, disabled: false, expectedRevision: x.revision }).then(() => toast(s.saved), fail),
            },
      ];
    };
    const email = (x: MemberRow) => (
      <span className="set-member">
        <Truncate full={x.email} maxWidth={320}>
          {x.email}
        </Truncate>
        {x.isYou ? <Pill tone="accent">{s.you}</Pill> : null}
      </span>
    );
    return [
      { key: "email", header: s.colMember, primary: true, type: "name", maxWidth: 320, sortable: true, cell: email },
      {
        key: "status",
        header: s.colStatus,
        type: "short",
        card: "status",
        sortable: true,
        cell: (x) => (x.status === "active" ? <StatusDot tone="success" label={s.active} /> : <StatusDot tone="neutral" label={s.disabled} />),
      },
      { key: "role", header: s.colRole, type: "short", card: "fact", sortable: true, cell: (x) => strings.app.roles[x.role] },
      { key: "created", header: s.colJoined, type: "date", card: "fact", sortable: true, sortDefaultDir: "desc", cell: (x) => <RelativeTime ms={x.createdAt} /> },
      ...(isOwner
        ? [{ key: "act", header: strings.common.actions, actions: true, rowActions: actionsOf, isEmpty: (x: MemberRow) => actionsOf(x).length === 0, cell: () => null } satisfies Column<MemberRow>]
        : []),
    ];
  }, [isOwner, resetCode, setDisabled, fail, toast]);

  return (
    <>
      {!isOwner ? <InlineNotice tone="neutral" title={strings.app.ownerOnly} /> : null}
      <div ref={box} className="set-members" data-aside={aside || undefined}>
        <div className="set-members__main">
          <ServerTable<MemberRow>
            framed
            caption={settingsStrings.nav.items.members}
            columns={cols}
            getKey={(x) => x._id}
            rowLabel={(x) => x.email}
            isDim={(x) => x.status === "disabled"}
            paging={paging}
            list={members}
            total={total}
            search={{ label: s.searchLabel, placeholder: s.searchPlaceholder }}
            toolbarEnd={
              <RoleGate minRole="owner">
                <Button onClick={() => setDialog({ kind: "invite" })}>
                  <IconUserPlus aria-hidden="true" />
                  {s.invite}
                </Button>
              </RoleGate>
            }
            empty={<EmptyState compact title={s.none} />}
          />
        </div>
        <InvitesCard onRevoke={askRevoke} aside={aside} />
      </div>

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

/**
 * Pending invites and reset codes (`members:invitesPage`): a second small list with its own pager; its URL parameters carry the
 * prefix `i`. Hidden while nothing is pending. Beside the members (`aside`) it is always cards: a table would not fit the narrow column.
 */
function InvitesCard({ onRevoke, aside }: { onRevoke: (invite: InviteRow) => void; aside: boolean }) {
  const isOwner = useCan("owner");
  const minute = useMinute();
  const view = useListView(INVITES_LIST);
  const [total, adoptTotal] = useAdoptedTotal();
  const paging = useListPaging(view, { total, offset: true });
  const invites = useInvitesPage(minute, paging.query);
  adoptTotal(invites);

  const cols = useMemo<Column<InviteRow>[]>(() => {
    const actionsOf = (i: InviteRow): RowAction[] => (isOwner ? [{ label: strings.common.revoke, danger: true, onSelect: () => onRevoke(i) }] : []);
    const kindOf = (i: InviteRow) => (i.kind === "join" ? strings.app.roles[i.role] : s.resetCodeTitle);
    const act: Column<InviteRow>[] = isOwner
      ? [{ key: "act", header: strings.common.actions, actions: true, rowActions: actionsOf, isEmpty: (i) => actionsOf(i).length === 0, cell: () => null }]
      : [];
    // Beside the members the column is narrow: the email with its type and expiry under it, and Revoke.
    if (aside) {
      return [
        {
          key: "email",
          header: s.colInvite,
          primary: true,
          type: "name",
          maxWidth: 235,
          sortable: true,
          cell: (i) => (
            <span className="dash-cell-stack">
              <Truncate full={i.email} maxWidth={235}>
                {i.email}
              </Truncate>
              <span className="dash-cell-sub">
                {kindOf(i)} · {s.expiresWord} <RelativeTime ms={i.expiresAt} />
              </span>
            </span>
          ),
        },
        ...act,
      ];
    }
    return [
      {
        key: "email",
        header: s.colInvite,
        primary: true,
        type: "name",
        maxWidth: 320,
        sortable: true,
        cell: (i) => (
          <Truncate full={i.email} maxWidth={320}>
            {i.email}
          </Truncate>
        ),
      },
      { key: "kind", header: s.colKind, type: "short", card: "fact", cell: kindOf },
      { key: "created", header: s.colInvited, type: "date", card: "fact", sortable: true, sortDefaultDir: "desc", cell: (i) => <RelativeTime ms={i.createdAt} /> },
      { key: "expires", header: s.colExpires, type: "date", card: "fact", sortable: true, cell: (i) => <RelativeTime ms={i.expiresAt} /> },
      ...act,
    ];  }, [isOwner, onRevoke, aside]);

  // Nothing pending (and no search that hid them): no card. Loading shows nothing either, so it does not jump.
  if (invites.status === "loading") return null;
  if (invites.status === "ready" && invites.items.length === 0 && view.search === "" && invites.total === 0) return null;
  const manyInvites = invites.status === "ready" && (invites.total ?? 0) > INVITES_SEARCH_MIN;
  return (
    <div className="set-members__aside">
      <Card title={s.pendingInvites} body="none" className="dash-card--tight">
        <ServerTable<InviteRow>
          caption={s.pendingInvites}
          columns={cols}
          getKey={(i) => i._id}
          rowLabel={(i) => i.email}
          paging={paging}
          list={invites}
          total={total}
          stack={aside ? false : undefined}
          search={manyInvites || view.search !== "" ? { label: s.invitesSearchLabel, placeholder: s.searchPlaceholder } : undefined}
          empty={<EmptyState compact title={s.none} />}
        />
      </Card>
    </div>
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
        <Field label={s.role}>{(p) => <Select {...p} value={f.values.role} onChange={(val) => f.set("role", val as Role)} options={ROLE_OPTIONS} />}</Field>
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
        <Field label={s.role}>{(p) => <Select {...p} value={f.values.role} onChange={(val) => f.set("role", val as Role)} options={ROLE_OPTIONS} />}</Field>
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

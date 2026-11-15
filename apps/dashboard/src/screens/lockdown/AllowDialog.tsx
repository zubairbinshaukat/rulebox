import { useState } from "react";
import { Button, Checkbox, Input, Select } from "@rulebox/ui";
import { useAllowFinding, useAllowOptions } from "../../data/lockdown";
import { MAX_ALLOW_GROUPS, MAX_EXCEPTION_REASON, type ExceptionKind, type FindingRow } from "../../data/types";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { allowKinds, folderProblem } from "./rules";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { findingsStrings as s, lockdownErrorMessage } from "./strings";

const KINDS: readonly ExceptionKind[] = ["publisher", "hash", "path"];

/**
 * "Allow for app…" (plan Step 19 item 2): the rule is proposed in this order: publisher (keeps working after updates), then the
 * exact file (marked "breaks on update"), then a folder, and a folder only when the program was found under one that only
 * administrators can change. Kinds that are not possible are listed with the reason, disabled. `lockdown:allowOptions` (the group
 * and program pickers) is subscribed only while this dialog is open.
 */
export function AllowDialog({ finding, onClose }: { finding: FindingRow | null; onClose: () => void }) {
  if (finding === null) return null;
  return <Inner key={finding._id} finding={finding} onClose={onClose} />;
}

function Inner({ finding, onClose }: { finding: FindingRow; onClose: () => void }) {
  const allow = useAllowFinding();
  const options = useAllowOptions();
  const toast = useToast();
  const possible = allowKinds(finding);
  const [kind, setKind] = useState<ExceptionKind | null>(possible[0] ?? null);
  const [folder, setFolder] = useState("");
  const [groupIds, setGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [appId, setAppId] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const groups = options.status === "ready" ? options.data.groups : [];
  const apps = options.status === "ready" ? options.data.apps : [];
  const badFolder = kind === "path" && folderProblem(folder);
  const noGroup = groupIds.size === 0;
  const tooMany = groupIds.size > MAX_ALLOW_GROUPS;
  const badReason = reason.trim().length > MAX_EXCEPTION_REASON;

  function submit() {
    setTouched(true);
    if (kind === null || badFolder || noGroup || tooMany || badReason || pending) return;
    setPending(true);
    setError(null);
    allow({
      findingId: finding._id,
      kind,
      ...(kind === "path" ? { folder: folder.trim() } : {}),
      groupIds: [...groupIds],
      ...(appId ? { appId } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }).then(
      (done) => {
        toast(s.allowed(done.added));
        onClose();
      },
      (e) => {
        setPending(false);
        setError(e);
      },
    );
  }

  const kindHelp = (k: ExceptionKind): string => {
    if (!possible.includes(k)) return s.kindUnavailable[k];
    return k === "publisher" ? s.kindHelp.publisher(finding.signer ?? "") : s.kindHelp[k];
  };

  return (
    <Modal
      open
      wide
      title={s.allowTitle(finding.fileName)}
      onClose={() => !pending && onClose()}
      onSubmit={submit}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending || kind === null} aria-busy={pending}>
            {pending ? s.allowing : s.allowConfirm}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-muted">{s.allowLead}</p>
        {possible.length === 0 ? <InlineNotice tone="warning" title={s.appControlNote} /> : null}
        <Field label={s.ruleKind} hint={kind === null ? undefined : kindHelp(kind)}>
          {(p) => (
            <Select {...p} value={kind ?? ""} disabled={pending || possible.length === 0} onChange={(e) => setKind(e.target.value as ExceptionKind)}>
              {kind === null ? <option value="">—</option> : null}
              {KINDS.map((k) => (
                <option key={k} value={k} disabled={!possible.includes(k)}>
                  {s.kinds[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {/* Why a kind is not offered, in words (a disabled option cannot explain itself). */}
        {KINDS.filter((k) => !possible.includes(k)).map((k) => (
          <p key={k} className="dash-cell-sub">
            {s.kinds[k]}: {s.kindUnavailable[k]}
          </p>
        ))}
        {kind === "path" ? (
          <Field label={s.folder} hint={s.folderHint} error={touched && badFolder ? s.folderProblem : null} required>
            {(p) => <Input {...p} value={folder} autoComplete="off" spellCheck={false} onChange={(e) => setFolder(e.target.value)} />}
          </Field>
        ) : null}
        <FieldSet legend={s.groups} hint={s.groupsHint} error={touched && noGroup ? s.groupsProblem : tooMany ? s.groupsTooMany : null}>
          {options.status === "ready" && groups.length === 0 ? <p className="dash-muted">{s.noGroups}</p> : null}
          <div className="dash-net__chips">
            {groups.map((g) => (
              <Checkbox
                key={g._id}
                label={g.name}
                checked={groupIds.has(g._id)}
                disabled={pending}
                onChange={(e) =>
                  setGroupIds((cur) => {
                    const next = new Set(cur);
                    if (e.target.checked) next.add(g._id);
                    else next.delete(g._id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </FieldSet>
        <Field label={s.app} hint={s.appHint} optional>
          {(p) => (
            <Select {...p} value={appId} disabled={pending} onChange={(e) => setAppId(e.target.value)}>
              <option value="">{s.appNone}</option>
              {apps.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={s.reason} hint={s.reasonHint} error={touched && badReason ? s.reasonProblem : null} optional>
          {(p) => <Input {...p} value={reason} autoComplete="off" disabled={pending} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {options.status === "error" ? <FormError error={options.error} /> : null}
        <FormError error={error} describe={lockdownErrorMessage} />
      </div>
    </Modal>
  );
}
